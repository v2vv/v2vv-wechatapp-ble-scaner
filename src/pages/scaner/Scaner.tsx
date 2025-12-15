import { useEffect } from "react";
import BLEService from "../../lib/blethooth/bleService";

export default function Index() {
  useEffect(() => {
    async function initBLE() {
      await BLEService.initBluetooth();
      await BLEService.startDiscovery();

      BLEService.onDeviceFound(async (devices) => {
        console.log("发现设备:", devices);

        // 假设我们直接连接第一个设备
        if (devices.length > 0) {
          const deviceId = devices[0].deviceId;
          await BLEService.connect(deviceId);

          const services = await BLEService.getServices();
          if (services && services.length > 0) {
            const serviceId = services[0].uuid;
            const chars = await BLEService.getCharacteristics(serviceId);

            if (chars && chars.length > 0) {
              const charId = chars[0].uuid;

              // 开启通知
              await BLEService.enableNotify(serviceId, charId);

              // 监听数据
              BLEService.onValueChange((data) => {
                console.log("收到数据:", data);
              });

              // 写入数据示例
              const buffer = new Uint8Array([0x01]).buffer;
              await BLEService.write(serviceId, charId, buffer);
            }
          }
        }
      });
    }

    initBLE();
  }, []);

  return <view>BLE 测试页面</view>;
}
