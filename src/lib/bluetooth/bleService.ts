// bleService.ts
import Taro from '@tarojs/taro'

export interface BLEDeviceProfile {
  serviceId: string
  writeCharId?: string
  notifyCharId?: string
}

class BLEService {
  connectedDevices = new Set<string>()
  deviceProfiles = new Map<string, BLEDeviceProfile>()
  writeQueue = new Map<string, Promise<any>>()
  disconnectCallback: ((deviceId: string) => void) | null = null

  onDisconnect(cb: (deviceId: string) => void) {
    this.disconnectCallback = cb
  }

  async initBluetooth() {
    try {
      await Taro.openBluetoothAdapter()
      console.log("✅ 蓝牙适配器初始化成功")

      // 系统断开事件监听
      Taro.onBLEConnectionStateChange((res) => {
        if (!res.connected) {
          console.log("⚠️ 系统断开:", res.deviceId)
          this.connectedDevices.delete(res.deviceId)
          this.deviceProfiles.delete(res.deviceId)
          this.disconnectCallback?.(res.deviceId)
        }
      })
    } catch (err) {
      console.error("❌ 蓝牙适配器初始化失败", err)
    }
  }

  async startDiscovery(options?: Taro.startBluetoothDevicesDiscovery.Option) {
    try {
      await Taro.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true,
        powerLevel: "high",
        ...options,
      })
      console.log("✅ 开始扫描设备 (高功率/高灵敏度)")
    } catch (err) {
      console.error("❌ 扫描失败", err)
    }
  }

  onDeviceFound(callback: (devices: any[]) => void) {
    Taro.onBluetoothDeviceFound((res) => callback(res.devices))
  }

  /**
   * 🌟 极速连接与初始化流水线 (Fast Connect & Profile Setup)
   * 1. 快速建立连接 (带 3.5s 超时，防假死)
   * 2. 优化 MTU 与连接间隔 (大幅提升传输速率与响应速度)
   * 3. 单次完成所有服务与特征值发现并建立内存缓存
   * 4. 立即开启 Notify
   */
  async fastConnectAndSetup(deviceId: string, timeout = 3500): Promise<BLEDeviceProfile> {
    if (this.connectedDevices.has(deviceId) && this.deviceProfiles.has(deviceId)) {
      return this.deviceProfiles.get(deviceId)!
    }

    try {
      // 1. 建立低延迟连接
      await Taro.createBLEConnection({ deviceId, timeout })
      this.connectedDevices.add(deviceId)
      console.log("✅ 快速连接建立:", deviceId)

      // 2. 尝试协商 MTU（加速数据传输）
      try {
        await Taro.setBLEMTU({ deviceId, mtu: 512 })
      } catch {}

      // 3. 单次获取全部 Services
      const services = await this.getServices(deviceId)
      if (!services || services.length === 0) {
        throw new Error("No services discovered")
      }

      // 优先匹配目标服务 A950 / FFF0
      const targetSvc =
        services.find(
          (s) =>
            s.uuid.toUpperCase().includes("A950") ||
            s.uuid.toUpperCase().includes("FFF0")
        ) || services[0]

      const serviceId = targetSvc.uuid

      // 4. 单次获取目标服务的所有特征值
      const chars = await this.getCharacteristics(deviceId, serviceId)

      let writeCharId: string | undefined
      let notifyCharId: string | undefined

      // 匹配写特征 (优先 A951 / FFF2 / 支持 write 的特征)
      const writeChar = chars.find(
        (c) =>
          c.uuid.toUpperCase().includes("A951") ||
          c.uuid.toUpperCase().includes("FFF2") ||
          c.properties?.write ||
          c.properties?.writeNoResponse
      )
      if (writeChar) {
        writeCharId = writeChar.uuid
      }

      // 匹配 notify 特征 (优先 A952 / FFF1 / 支持 notify 的特征)
      const notifyChar = chars.find(
        (c) =>
          c.uuid.toUpperCase().includes("A952") ||
          c.uuid.toUpperCase().includes("FFF1") ||
          c.properties?.notify ||
          c.properties?.indicate
      )
      if (notifyChar) {
        notifyCharId = notifyChar.uuid
      }

      const profile: BLEDeviceProfile = {
        serviceId,
        writeCharId,
        notifyCharId,
      }

      // 写入内存特征缓存
      this.deviceProfiles.set(deviceId, profile)

      // 5. 立即开启 Notify
      if (notifyCharId) {
        await this.notify(deviceId, serviceId, notifyCharId)
      }

      console.log("⚡ 设备特征值初始化完毕 (已缓存):", deviceId, profile)
      return profile
    } catch (err) {
      console.error("❌ 极速连接/初始化失败:", deviceId, err)
      this.connectedDevices.delete(deviceId)
      this.deviceProfiles.delete(deviceId)
      throw err
    }
  }

  async getServices(deviceId: string) {
    try {
      const res = await Taro.getBLEDeviceServices({ deviceId })
      return res.services || []
    } catch (err) {
      console.error("❌ 获取服务失败:", deviceId, err)
      throw err
    }
  }

  async getCharacteristics(deviceId: string, serviceId: string) {
    try {
      const res = await Taro.getBLEDeviceCharacteristics({
        deviceId,
        serviceId,
      })
      return res.characteristics || []
    } catch (err) {
      if ((err as any).errCode === 10005) return []
      console.error("❌ 获取特征失败:", deviceId, err)
      throw err
    }
  }

  /**
   * 🌟 极速直接写入（0ms 读取缓存特征值，无需空中二次探测）
   */
  async fastWrite(deviceId: string, buffer: ArrayBuffer) {
    const profile = this.deviceProfiles.get(deviceId)
    if (!profile || !profile.writeCharId) {
      throw new Error(`Device profile or write characteristic not ready: ${deviceId}`)
    }

    return this.write(deviceId, profile.serviceId, profile.writeCharId, buffer)
  }

  /** ✅ 写入队列 + 写入失败自动判定断开 */
  async write(deviceId: string, serviceId: string, charId: string, buffer: ArrayBuffer) {
    const last = this.writeQueue.get(deviceId) || Promise.resolve()

    const next = last.then(async () => {
      try {
        await Taro.writeBLECharacteristicValue({
          deviceId,
          serviceId,
          characteristicId: charId,
          value: buffer,
        })
      } catch (err: any) {
        console.error("❌ 写入失败:", deviceId, err)

        if (err.errCode === 10006 || err.errCode === 10003) {
          console.log("⚠️ 写入失败 → 判定断开:", deviceId)
          this.connectedDevices.delete(deviceId)
          this.deviceProfiles.delete(deviceId)
          this.disconnectCallback?.(deviceId)
        }
        throw err
      }
    })

    this.writeQueue.set(deviceId, next)
    return next
  }

  /** ✅ notify 失败也判定断开 */
  async notify(deviceId: string, serviceId: string, charId: string) {
    try {
      await Taro.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId,
        characteristicId: charId,
        state: true,
      })
      console.log("✅ Notify 开启成功:", deviceId)
    } catch (err: any) {
      console.error("❌ Notify 开启失败:", deviceId, err)

      if (err.errCode === 10006 || err.errCode === 10003) {
        console.log("⚠️ Notify 失败 → 判定断开:", deviceId)
        this.connectedDevices.delete(deviceId)
        this.deviceProfiles.delete(deviceId)
        this.disconnectCallback?.(deviceId)
      }
    }
  }

  onNotify(callback: (res: any) => void) {
    Taro.onBLECharacteristicValueChange((res) => callback(res))
  }

  async disconnect(deviceId: string) {
    if (!this.connectedDevices.has(deviceId)) return

    try {
      await Taro.closeBLEConnection({ deviceId })
      console.log("✅ 手动断开:", deviceId)
    } catch (err) {
      console.error("❌ 断开失败:", deviceId, err)
    }

    this.connectedDevices.delete(deviceId)
    this.deviceProfiles.delete(deviceId)
    this.disconnectCallback?.(deviceId)
  }
}

export default new BLEService()
