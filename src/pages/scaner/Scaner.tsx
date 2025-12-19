import { useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import BLEService from "../../lib/bluetooth/bleService";

export default function Index() {
  const [deviceList, setDeviceList] = useState([]);
  const [notifyMap, setNotifyMap] = useState({});
  const [autoConnectEnabled, setAutoConnectEnabled] = useState(false);

  const connectedSet = useRef(new Set());
  const autoConnectRef = useRef(false);

  useEffect(() => {
    autoConnectRef.current = autoConnectEnabled;
  }, [autoConnectEnabled]);

  useEffect(() => {
    initBLE();
  }, []);

  const initBLE = async () => {
    await BLEService.initBluetooth();
    await BLEService.startDiscovery();

    /** ✅ BLEService 通知断开 → 强制清除 */
    BLEService.onDisconnect((deviceId) => {
      console.log("⚠️ UI 收到断开:", deviceId);
      removeDevice(deviceId);
    });

    /** ✅ 扫描设备 */
    BLEService.onDeviceFound((devices) => {
      setDeviceList((prev) => {
        const list = [...prev];

        devices.forEach((d) => {
          if (!d.name || !d.name.startsWith("632")) return;

          d.lastSeen = Date.now();

          const exists = list.find((i) => i.deviceId === d.deviceId);

          if (!exists) {
            list.push(d);

            if (autoConnectRef.current) {
              handleConnect(d.deviceId);
            }
          } else {
            exists.RSSI = d.RSSI;
            exists.lastSeen = Date.now();
          }
        });

        return [...list];
      });
    });

    /** ✅ Notify 分发 */
    BLEService.onNotify((res) => {
      const hex = [...new Uint8Array(res.value)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(" ");

      setNotifyMap((prev) => ({
        ...prev,
        [res.deviceId]: hex,
      }));
    });
  };

  /** ✅ 未连接设备才用 lastSeen 判断 */
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();

      setDeviceList((prev) => {
        return prev.filter((d) => {
          const isConnected = connectedSet.current.has(d.deviceId);

          if (isConnected) return true; // ✅ 已连接设备不使用 lastSeen

          const alive = now - d.lastSeen < 3000;
          if (!alive) removeDevice(d.deviceId);
          return alive;
        });
      });
    }, 2000);

    return () => clearInterval(timer);
  }, []);

  /** ✅ 主动探测断开（核心：快速清除） */
  useEffect(() => {
    const timer = setInterval(async () => {
      for (const deviceId of connectedSet.current) {
        try {
          await Taro.getBLEDeviceRSSI({ deviceId });
          // ✅ 设备正常
        } catch (err) {
          console.log("⚠️ RSSI 探测失败 → 判定断开:", deviceId);
          removeDevice(deviceId);
        }
      }
    }, 2000); // ✅ 每 2 秒探测一次即可

    return () => clearInterval(timer);
  }, []);

  /** ✅ 幂等清除设备 */
  const removeDevice = (deviceId) => {
    connectedSet.current.delete(deviceId);

    setNotifyMap((prev) => {
      const newMap = { ...prev };
      delete newMap[deviceId];
      return newMap;
    });

    setDeviceList((prev) => prev.filter((d) => d.deviceId !== deviceId));
  };

  /** ✅ 连接设备 */
  const handleConnect = async (deviceId) => {
    if (connectedSet.current.has(deviceId)) return;

    await BLEService.connect(deviceId);
    connectedSet.current.add(deviceId);

    await enableNotify(deviceId);
  };

  /** ✅ 开启 Notify */
  const enableNotify = async (deviceId) => {
    const services = await BLEService.getServices(deviceId);
    if (!services) return;

    const svc = services.find((s) => s.uuid.includes("FFF0"));
    if (!svc) return;

    const chars = await BLEService.getCharacteristics(deviceId, svc.uuid);
    const notifyChar = chars.find((c) => c.uuid.includes("FFF1"));
    if (!notifyChar) return;

    await BLEService.notify(deviceId, svc.uuid, notifyChar.uuid);
  };

  /** ✅ 自动连接所有设备 */
  const autoConnectAllDevices = async () => {
    setAutoConnectEnabled(true);

    for (const dev of deviceList) {
      if (dev.name?.startsWith("632")) {
        await handleConnect(dev.deviceId);
      }
    }
  };

  /** ✅ 手动断开 */
  const handleDisconnect = async (deviceId) => {
    await BLEService.disconnect(deviceId);
    removeDevice(deviceId);
  };

  /** ✅ 写入固定字符 */
  const sendA950FixedText = async (deviceId) => {
    const buffer = new TextEncoder().encode("Hello A950").buffer;
    await BLEService.write(deviceId, "FFF0", "FFF2", buffer);
  };

  return (
    <view style={{ padding: "16px" }}>
      <view style={{ fontSize: "18px", fontWeight: "bold" }}>
        BLE 多设备测试页面
      </view>

      <button
        style={{
          marginTop: "16px",
          backgroundColor: "#722ed1",
          color: "#fff",
          padding: "8px 14px",
          borderRadius: "6px",
        }}
        onClick={autoConnectAllDevices}
      >
        ⚡ 自动连接所有 632 设备（持续）
      </button>

      <view style={{ marginTop: "20px" }}>
        <view>扫描到的设备（632 开头）：</view>

        {deviceList.map((item) => {
          const isConnected = connectedSet.current.has(item.deviceId);

          return (
            <view
              key={item.deviceId}
              style={{
                padding: "12px",
                borderBottom: "1px solid #ccc",
                backgroundColor: isConnected ? "#e6f7ff" : "transparent",
              }}
            >
              <view>名称：{item.name}</view>
              <view>ID：{item.deviceId}</view>
              <view>RSSI：{item.RSSI}</view>

              {isConnected ? (
                <>
                  <button
                    style={{
                      marginTop: "8px",
                      backgroundColor: "#ff4d4f",
                      color: "#fff",
                    }}
                    onClick={() => handleDisconnect(item.deviceId)}
                  >
                    断开连接
                  </button>

                  <button
                    style={{
                      marginTop: "8px",
                      backgroundColor: "#1677ff",
                      color: "#fff",
                    }}
                    onClick={() => sendA950FixedText(item.deviceId)}
                  >
                    发送固定字符
                  </button>

                  {notifyMap[item.deviceId] && (
                    <view
                      style={{
                        marginTop: "8px",
                        backgroundColor: "#000",
                        color: "#fff",
                        padding: "6px 10px",
                        borderRadius: "6px",
                        fontSize: "12px",
                      }}
                    >
                      通知：{notifyMap[item.deviceId]}
                    </view>
                  )}
                </>
              ) : (
                <button
                  style={{
                    marginTop: "8px",
                    backgroundColor: "#52c41a",
                    color: "#fff",
                  }}
                  onClick={() => handleConnect(item.deviceId)}
                >
                  连接设备
                </button>
              )}
            </view>
          );
        })}
      </view>
    </view>
  );
}
