// bleService.ts
import Taro from '@tarojs/taro'

class BLEService {
  connectedDevices = new Set<string>()
  writeQueue = new Map<string, Promise<any>>()
  disconnectCallback = null

  onDisconnect(cb) {
    this.disconnectCallback = cb
  }

  async initBluetooth() {
    try {
      await Taro.openBluetoothAdapter()
      console.log("✅ 蓝牙适配器初始化成功")

      // ✅ 系统断开事件（不稳定，但作为辅助）
      Taro.onBLEConnectionStateChange((res) => {
        if (!res.connected) {
          console.log("⚠️ 系统断开:", res.deviceId)
          this.connectedDevices.delete(res.deviceId)
          this.disconnectCallback?.(res.deviceId)
        }
      })
    } catch (err) {
      console.error("❌ 蓝牙适配器初始化失败", err)
    }
  }

  async startDiscovery() {
    try {
      await Taro.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true,
      })
      console.log("✅ 开始扫描设备")
    } catch (err) {
      console.error("❌ 扫描失败", err)
    }
  }

  onDeviceFound(callback) {
    Taro.onBluetoothDeviceFound((res) => callback(res.devices))
  }

  async connect(deviceId: string) {
    if (this.connectedDevices.has(deviceId)) return

    try {
      await Taro.createBLEConnection({ deviceId })
      this.connectedDevices.add(deviceId)
      console.log("✅ 连接成功:", deviceId)
    } catch (err) {
      console.error("❌ 连接失败:", deviceId, err)
    }
  }

  async getServices(deviceId: string) {
    try {
      const res = await Taro.getBLEDeviceServices({ deviceId })
      return res.services
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
      if (err.errCode === 10005) return []
      console.error("❌ 获取特征失败:", deviceId, err)
      throw err
    }
  }

  /** ✅ 写入队列 + 写入失败自动判定断开 */
  async write(deviceId, serviceId, charId, buffer) {
    const last = this.writeQueue.get(deviceId) || Promise.resolve()

    const next = last.then(async () => {
      try {
        await Taro.writeBLECharacteristicValue({
          deviceId,
          serviceId,
          characteristicId: charId,
          value: buffer,
        })
        console.log("✅ 写入成功:", deviceId)
      } catch (err) {
        console.error("❌ 写入失败:", deviceId, err)

        if (err.errCode === 10006 || err.errCode === 10003) {
          console.log("⚠️ 写入失败 → 判定断开:", deviceId)
          this.connectedDevices.delete(deviceId)
          this.disconnectCallback?.(deviceId)
        }
      }
    })

    this.writeQueue.set(deviceId, next)
    return next
  }

  /** ✅ notify 失败也判定断开 */
  async notify(deviceId, serviceId, charId) {
    try {
      await Taro.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId,
        characteristicId: charId,
        state: true,
      })
      console.log("✅ Notify 开启:", deviceId)
    } catch (err) {
      console.error("❌ Notify 开启失败:", deviceId, err)

      if (err.errCode === 10006 || err.errCode === 10003) {
        console.log("⚠️ Notify 失败 → 判定断开:", deviceId)
        this.connectedDevices.delete(deviceId)
        this.disconnectCallback?.(deviceId)
      }
    }
  }

  onNotify(callback) {
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
    this.disconnectCallback?.(deviceId)
  }
}

export default new BLEService()
