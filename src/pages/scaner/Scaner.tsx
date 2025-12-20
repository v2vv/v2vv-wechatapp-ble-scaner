import { useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import BLEService from "../../lib/bluetooth/bleService";

export default function Index() {
  const [deviceList, setDeviceList] = useState([]);
  const [notifyMap, setNotifyMap] = useState({});
  const [autoConnectEnabled, setAutoConnectEnabled] = useState(false);
  const [autoModeRunning, setAutoModeRunning] = useState(false);

  const [whiteMode, setWhiteMode] = useState(null);
  // null = 默认
  // "static" = 静态白灯
  // "full" = 全白灯
  // "rainbow" = 七彩渐变

  const connectedSet = useRef(new Set());
  const writtenSet = useRef(new Set());
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

    BLEService.onDisconnect((deviceId) => {
      console.log("⚠️ UI 收到断开:", deviceId);
      removeDevice(deviceId);
    });

    BLEService.onDeviceFound((devices) => {
      setDeviceList((prev) => {
        const list = [...prev];

        devices.forEach((d) => {
          if (!d.name || !d.name.startsWith("632")) return;

          d.lastSeen = Date.now();
          d.missCount = 0;

          const exists = list.find((i) => i.deviceId === d.deviceId);

          if (!exists) {
            list.push(d);

            if (autoConnectRef.current) {
              handleConnect(d.deviceId);
            }
          } else {
            exists.RSSI = d.RSSI;
            exists.lastSeen = Date.now();
            exists.missCount = 0;
          }
        });

        return [...list];
      });
    });

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

  /** ✅ 未连接设备：稳定窗口判断 */
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();

      setDeviceList((prev) => {
        return prev.filter((d) => {
          const isConnected = connectedSet.current.has(d.deviceId);

          if (isConnected) return true;

          if (now - d.lastSeen > 2000) {
            d.missCount = (d.missCount || 0) + 1;
          }

          if (d.missCount >= 3) {
            console.log("✅ 未连接设备消失:", d.deviceId);
            removeDevice(d.deviceId);
            return false;
          }

          return true;
        });
      });
    }, 2000);

    return () => clearInterval(timer);
  }, []);

  /** ✅ 已连接设备：RSSI 主动探测 */
  useEffect(() => {
    const timer = setInterval(async () => {
      for (const deviceId of connectedSet.current) {
        try {
          await Taro.getBLEDeviceRSSI({ deviceId });
        } catch (err) {
          console.log("⚠️ RSSI 探测失败 → 判定断开:", deviceId);
          removeDevice(deviceId);
        }
      }
    }, 2000);

    return () => clearInterval(timer);
  }, []);

  /** ✅ 幂等清除设备 */
  const removeDevice = (deviceId) => {
    connectedSet.current.delete(deviceId);
    writtenSet.current.delete(deviceId);

    setNotifyMap((prev) => {
      const newMap = { ...prev };
      delete newMap[deviceId];
      return newMap;
    });

    setDeviceList((prev) => prev.filter((d) => d.deviceId !== deviceId));
  };

  /** ✅ 写入 A951 字段 */
  const writeA951 = async (deviceId, hex) => {
    const buffer = new Uint8Array(
      hex.match(/.{2}/g).map((b) => parseInt(b, 16))
    ).buffer;

    try {
      const services = await BLEService.getServices(deviceId);
      const svc = services.find((s) => s.uuid.toUpperCase().includes("A950"));
      if (!svc) return;

      const chars = await BLEService.getCharacteristics(deviceId, svc.uuid);
      const writeChar = chars.find((c) =>
        c.uuid.toUpperCase().includes("A951")
      );
      if (!writeChar) return;

      await BLEService.write(deviceId, svc.uuid, writeChar.uuid, buffer);
      console.log("✅ A951 写入成功:", deviceId);
    } catch (err) {
      console.log("⚠️ A951 写入失败:", deviceId, err);
    }
  };

  /** ✅ 自动写入（新设备连接） */
  const sendA950ToDevice = (deviceId) => {
    const hex = "55AA020B0101FFFFFF0000006526000000";
    writeA951(deviceId, hex);
  };

  /** ✅ 连接设备（自动写入） */
  const handleConnect = async (deviceId) => {
    if (connectedSet.current.has(deviceId)) return;

    await BLEService.connect(deviceId);
    connectedSet.current.add(deviceId);

    await enableNotify(deviceId);

    if (autoModeRunning && !writtenSet.current.has(deviceId)) {
      writtenSet.current.add(deviceId);
      sendA950ToDevice(deviceId);
    }
  };

  /** ✅ 开启 Notify */
  const enableNotify = async (deviceId) => {
    const services = await BLEService.getServices(deviceId);
    if (!services) return;

    const svc = services.find(
      (s) => s.uuid.includes("FFF0") || s.uuid.includes("A950")
    );
    if (!svc) return;

    const chars = await BLEService.getCharacteristics(deviceId, svc.uuid);
    const notifyChar = chars.find(
      (c) => c.uuid.includes("FFF1") || c.uuid.includes("A952")
    );
    if (!notifyChar) return;

    await BLEService.notify(deviceId, svc.uuid, notifyChar.uuid);
  };

  /** ✅ 自动模式：一键连接 / 一键断开 */
  const toggleAutoMode = async () => {
    if (!autoModeRunning) {
      setAutoModeRunning(true);
      setAutoConnectEnabled(true);

      for (const dev of deviceList) {
        if (dev.name?.startsWith("632")) {
          await handleConnect(dev.deviceId);
        }
      }

      console.log("✅ 自动模式已开启");
    } else {
      setAutoModeRunning(false);
      setAutoConnectEnabled(false);

      const list = Array.from(connectedSet.current);
      for (const deviceId of list) {
        try {
          await BLEService.disconnect(deviceId);
        } catch {}
        removeDevice(deviceId);
      }

      console.log("✅ 自动模式已关闭");
    }
  };

  /** ✅ 静态白灯 */
  const sendStaticWhite = async () => {
    const hex = "55AA020B0101FFFFFF0000006526000000";

    const tasks = [];
    for (const deviceId of connectedSet.current) {
      tasks.push(writeA951(deviceId, hex));
    }

    await Promise.all(tasks);
    setWhiteMode("static");
    console.log("✅ 静态白灯写入完成");
  };

  /** ✅ 全白灯 */
  const sendFullWhite = async () => {
    const hex =
      "55AA0837ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff016464010000";

    const tasks = [];
    for (const deviceId of connectedSet.current) {
      tasks.push(writeA951(deviceId, hex));
    }

    await Promise.all(tasks);
    setWhiteMode("full");
    console.log("✅ 全白灯写入完成");
  };

  /** ✅ 七彩渐变 */
  const sendRainbow = async () => {
    const hex = "55AA020B03010000000000006515000000";

    const tasks = [];
    for (const deviceId of connectedSet.current) {
      tasks.push(writeA951(deviceId, hex));
    }

    await Promise.all(tasks);
    setWhiteMode("rainbow");
    console.log("✅ 七彩渐变写入完成");
  };

  /** ✅ 手动断开 */
  const handleDisconnect = async (deviceId) => {
    await BLEService.disconnect(deviceId);
    removeDevice(deviceId);
  };

  return (
    <view style={{ padding: "16px" }}>
      <view style={{ fontSize: "18px", fontWeight: "bold" }}>
        BLE 多设备测试页面
      </view>

      {/* ✅ 自动模式按钮 */}
      <button
        style={{
          marginTop: "16px",
          backgroundColor: autoModeRunning ? "#ff4d4f" : "#722ed1",
          color: "#fff",
          padding: "8px 14px",
          borderRadius: "6px",
        }}
        onClick={toggleAutoMode}
      >
        {autoModeRunning
          ? "🔌 停止自动模式（断开所有设备）"
          : "⚡ 启动自动模式（自动连接 + 自动写入）"}
      </button>

      {/* ✅ 静态白灯 */}
      <button
        style={{
          marginTop: "16px",
          backgroundColor: whiteMode === "static" ? "#1677ff" : "#666",
          color: "#fff",
          padding: "8px 14px",
          borderRadius: "6px",
        }}
        onClick={() => {
          sendStaticWhite();
          setWhiteMode("static");
        }}
      >
        静态白灯
      </button>

      {/* ✅ 全白灯 */}
      <button
        style={{
          marginTop: "16px",
          backgroundColor: whiteMode === "full" ? "#faad14" : "#666",
          color: "#fff",
          padding: "8px 14px",
          borderRadius: "6px",
        }}
        onClick={() => {
          sendFullWhite();
          setWhiteMode("full");
        }}
      >
        全白灯
      </button>

      {/* ✅ 七彩渐变 */}
      <button
        style={{
          marginTop: "16px",
          backgroundColor: whiteMode === "rainbow" ? "#13c2c2" : "#666",
          color: "#fff",
          padding: "8px 14px",
          borderRadius: "6px",
        }}
        onClick={() => {
          sendRainbow();
          setWhiteMode("rainbow");
        }}
      >
        七彩渐变
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
