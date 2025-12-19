// bleService.ts
import Taro from '@tarojs/taro'

class BLEService {
  private connectedDeviceId: string | null = null

  /** 初始化蓝牙适配器 */
  async initBluetooth() {
    try {
      await Taro.openBluetoothAdapter()
      console.log('蓝牙适配器初始化成功')
    } catch (err) {
      console.error('蓝牙适配器初始化失败', err)
    }
  }

  /** 开始搜索设备 */
  async startDiscovery() {
    try {
      await Taro.startBluetoothDevicesDiscovery({ allowDuplicatesKey: false })
      console.log('开始搜索设备')
    } catch (err) {
      console.error('搜索设备失败', err)
    }
  }

  /** 监听发现设备 */
  onDeviceFound(callback: (devices: any[]) => void) {
    Taro.onBluetoothDeviceFound((res) => {
      callback(res.devices)
    })
  }

  /** 连接设备 */
  async connect(deviceId: string) {
    try {
      await Taro.createBLEConnection({ deviceId })
      this.connectedDeviceId = deviceId
      console.log('连接成功:', deviceId)
    } catch (err) {
      console.error('连接失败', err)
    }
  }

  /** 获取服务列表 */
  async getServices() {
    if (!this.connectedDeviceId) return
    try {
      const res = await Taro.getBLEDeviceServices({
        deviceId: this.connectedDeviceId,
      })
      console.log('服务列表:', res.services)
      return res.services
    } catch (err) {
      console.error('获取服务失败', err)
    }
  }

  /** 获取特征值列表 */
 async getCharacteristics(deviceId: string, serviceId: string) {
  return new Promise((resolve, reject) => {
    Taro.getBLEDeviceCharacteristics({
      deviceId,
      serviceId,
      success: (res) => {
        resolve(res.characteristics || []);
      },
      fail: (err) => {
        // ✅ 对无特征服务不报错，直接返回空数组
        if (err.errCode === 10005) {
          console.warn("服务无特征:", serviceId);
          resolve([]);
          return;
        }
        reject(err);
      }
    });
  });
}


  /** 写入数据 */
  async write(serviceId: string, characteristicId: string, buffer: ArrayBuffer) {
    if (!this.connectedDeviceId) return
    try {
      await Taro.writeBLECharacteristicValue({
        deviceId: this.connectedDeviceId,
        serviceId,
        characteristicId,
        value: buffer,
      })
      console.log('写入成功')
    } catch (err) {
      console.error('写入失败', err)
    }
  }

  /** 开启通知（iOS 必须） */
  async enableNotify(serviceId: string, characteristicId: string) {
    if (!this.connectedDeviceId) return
    try {
      await Taro.notifyBLECharacteristicValueChange({
        deviceId: this.connectedDeviceId,
        serviceId,
        characteristicId,
        state: true,
      })
      console.log('通知已开启')
    } catch (err) {
      console.error('开启通知失败', err)
    }
  }

  /** 监听数据变化 */
  onValueChange(callback: (data: Uint8Array) => void) {
    Taro.onBLECharacteristicValueChange((res) => {
      const value = new Uint8Array(res.value)
      callback(value)
    })
  }

  // ✅ 开启通知
  notify(deviceId, serviceId, characteristicId) {
    return new Promise((resolve, reject) => {
      Taro.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId,
        characteristicId,
        state: true,
        success: resolve,
        fail: reject,
      });
    });
  }

   // ✅ 监听通知回调
  onNotify(callback) {
    Taro.onBLECharacteristicValueChange((res) => {
      callback(res);
    });
  }

  /** 断开连接 */
  async disconnect() {
    if (!this.connectedDeviceId) return
    try {
      await Taro.closeBLEConnection({ deviceId: this.connectedDeviceId })
      console.log('断开连接:', this.connectedDeviceId)
      this.connectedDeviceId = null
    } catch (err) {
      console.error('断开失败', err)
    }
  }
}

export default new BLEService()
