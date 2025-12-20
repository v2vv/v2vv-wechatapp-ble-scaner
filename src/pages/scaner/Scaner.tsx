import { useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { View, Text } from "@tarojs/components";
import BLEService from "../../lib/bluetooth/bleService";
import { VirtualList } from "@nutui/nutui-react-taro";
import "./Scaner.scss";

interface BLEDevice {
  deviceId: string;
  name?: string;
  RSSI: number;
  lastSeen: number;
  missCount: number;
}

export default function Index() {
  const [deviceList, setDeviceList] = useState<BLEDevice[]>([]);
  const [notifyMap, setNotifyMap] = useState<Record<string, string>>({});
  const [autoConnectEnabled, setAutoConnectEnabled] = useState(false);
  const [autoModeRunning, setAutoModeRunning] = useState(false);

  const [whiteMode, setWhiteMode] = useState(null);

  const connectedSet = useRef(new Set());
  const writtenSet = useRef(new Set());
  const autoConnectRef = useRef(false);

  /** ✅ LIGHT MODE COMMANDS */
  const LIGHT_MODES = {
    static: {
      name: "静态白灯",
      color: "#1677ff", // Blue
      hex: "55AA020B0101FFFFFF0000006526000000",
      bg: "linear-gradient(135deg, #36cfc9 0%, #1677ff 100%)",
    },
    full: {
      name: "全白灯",
      color: "#faad14", // Orange
      hex: "55AA0837ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff016464010000",
      bg: "linear-gradient(135deg, #ffc53d 0%, #faad14 100%)",
    },
    rainbow: {
      name: "七彩渐变",
      color: "#722ed1", // Purple
      hex: "55AA020B03010000000000006515000000",
      bg: "linear-gradient(135deg, #f759ab 0%, #722ed1 100%)",
    },
  };

  useEffect(() => {
    autoConnectRef.current = autoConnectEnabled;
  }, [autoConnectEnabled]);

  useEffect(() => {
    initBLE();
  }, []);

  /** ✅ BLE INIT */
  const initBLE = async () => {
    await BLEService.initBluetooth();
    await BLEService.startDiscovery();

    BLEService.onDisconnect((deviceId) => removeDevice(deviceId));

    BLEService.onDeviceFound((devices) => {
      setDeviceList((prev) => {
        const list = [...prev];

        devices.forEach((d) => {
          if (!d.name?.startsWith("632")) return;

          d.lastSeen = Date.now();
          d.missCount = 0;

          const exists = list.find((i) => i.deviceId === d.deviceId);

          if (!exists) {
            list.push(d);
            if (autoConnectRef.current) handleConnect(d.deviceId);
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

      setNotifyMap((prev) => ({ ...prev, [res.deviceId]: hex }));
    });
  };

  /** ✅ CONNECTIONS WATCHDOG */
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();

      setDeviceList((prev) =>
        prev.filter((d) => {
          if (connectedSet.current.has(d.deviceId)) return true;

          if (now - d.lastSeen > 2000) d.missCount++;

          if (d.missCount >= 3) {
            removeDevice(d.deviceId);
            return false;
          }

          return true;
        })
      );
    }, 2000);

    return () => clearInterval(timer);
  }, []);

  /** ✅ RSSI CHECK */
  useEffect(() => {
    const timer = setInterval(async () => {
      for (const deviceId of connectedSet.current) {
        try {
          await Taro.getBLEDeviceRSSI({ deviceId });
        } catch {
          removeDevice(deviceId);
        }
      }
    }, 2000);

    return () => clearInterval(timer);
  }, []);

  /** ✅ REMOVE DEVICE */
  const removeDevice = (deviceId) => {
    connectedSet.current.delete(deviceId);
    writtenSet.current.delete(deviceId);

    setNotifyMap((prev) => {
      const m = { ...prev };
      delete m[deviceId];
      return m;
    });

    setDeviceList((prev) => prev.filter((d) => d.deviceId !== deviceId));
  };

  /** ✅ WRITE A951 */
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
    } catch (err) {
      console.log("⚠️ Write Failed:", deviceId, err);
    }
  };

  /** ✅ WRITE MODE */
  const writeMode = async (modeKey) => {
    const mode = LIGHT_MODES[modeKey];
    if (!mode) return;

    const tasks = [];
    for (const deviceId of connectedSet.current) {
      tasks.push(writeA951(deviceId, mode.hex));
    }

    await Promise.all(tasks);
    setWhiteMode(modeKey);
  };

  /** ✅ AUTO WRITE */
  const autoWrite = (deviceId) => {
    const hex = LIGHT_MODES.static.hex;
    writeA951(deviceId, hex);
  };

  /** ✅ CONNECT */
  const handleConnect = async (deviceId) => {
    if (connectedSet.current.has(deviceId)) return;

    await BLEService.connect(deviceId);
    connectedSet.current.add(deviceId);

    await enableNotify(deviceId);

    if (autoModeRunning && !writtenSet.current.has(deviceId)) {
      writtenSet.current.add(deviceId);
      autoWrite(deviceId);
    }
  };

  /** ✅ ENABLE NOTIFY */
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

  /** ✅ TOGGLE AUTO MODE */
  const toggleAutoMode = async () => {
    if (!autoModeRunning) {
      setAutoModeRunning(true);
      setAutoConnectEnabled(true);

      for (const dev of deviceList) {
        if (dev.name?.startsWith("632")) await handleConnect(dev.deviceId);
      }
    } else {
      setAutoModeRunning(false);
      setAutoConnectEnabled(false);

      for (const deviceId of Array.from(connectedSet.current)) {
        try {
          await BLEService.disconnect(deviceId);
        } catch {}
        removeDevice(deviceId);
      }
    }
  };

  /** ✅ DISCONNECT */
  const handleDisconnect = async (deviceId) => {
    await BLEService.disconnect(deviceId);
    removeDevice(deviceId);
  };

  return (
    <View className="scaner-page">
      {/* Header Section */}
      <View className="header">
        <View className="title">BLE Device Manager</View>
        <View className="subtitle">多设备批量控制 & 自动化测试</View>
      </View>

      {/* Control Section */}
      <View className="section-card">
        <View className="section-title">全局控制</View>

        {/* Auto Mode Switch */}
        <View className="auto-switch-container">
          <View className="switch-info">
            <View className="label">自动化接管</View>
            <View
              className={`status ${autoModeRunning ? "active" : "inactive"}`}
            >
              {autoModeRunning ? "正在自动连接并配置设备..." : "手动模式"}
            </View>
          </View>
          <View
            className={`switch-btn ${autoModeRunning ? "on" : "off"}`}
            onClick={toggleAutoMode}
          >
            {autoModeRunning ? "STOP AUTO" : "START AUTO"}
          </View>
        </View>
      </View>

      {/* Light Mode Section */}
      <View className="section-card">
        <View className="section-title">灯光模式</View>
        <View className="color-grid">
          {Object.entries(LIGHT_MODES).map(([key, mode]) => (
            <View
              key={key}
              className={`color-card ${whiteMode === key ? "active" : ""}`}
              style={{ background: mode.bg || mode.color }}
              onClick={() => writeMode(key)}
            >
              <View className="ripple" />
              <View className="color-name">{mode.name}</View>
            </View>
          ))}
        </View>
      </View>

      {/* Device List Section */}
      <View className="device-list-card">
        <View className="list-header-bar">
          <View>发现设备 ({deviceList.length})</View>
          <View>已连接: {Array.from(connectedSet.current).length}</View>
        </View>

        <VirtualList
          list={deviceList}
          itemHeight={160}
          height={550}
          itemRender={(item: BLEDevice) => {
            const isConnected = connectedSet.current.has(item.deviceId);
            const rssiLevel =
              item.RSSI > -60 ? "good" : item.RSSI > -80 ? "fair" : "poor";

            return (
              <View className="device-item-container" key={item.deviceId}>
                <View
                  className={`device-card ${isConnected ? "connected" : ""}`}
                >
                  <View className="card-top">
                    <View className="device-info">
                      <View className="icon-box">
                        <Text>{isConnected ? "🔗" : "📡"}</Text>
                      </View>
                      <View className="text-info">
                        <View className="name">
                          {item.name || "Unknown Device"}
                        </View>
                        <View className="id">{item.deviceId}</View>
                      </View>
                    </View>
                    <View className={`rssi-box ${rssiLevel}`}>
                      <Text>📶 {item.RSSI}</Text>
                    </View>
                  </View>

                  <View className="card-actions">
                    {isConnected ? (
                      <View
                        className="action-btn btn-disconnect"
                        onClick={() => handleDisconnect(item.deviceId)}
                      >
                        断开连接
                      </View>
                    ) : (
                      <View
                        className="action-btn btn-connect"
                        onClick={() => handleConnect(item.deviceId)}
                      >
                        连接设备
                      </View>
                    )}
                  </View>

                  {isConnected && notifyMap[item.deviceId] && (
                    <View className="log-console">
                      <Text className="log-label">Notification Data</Text>
                      <Text className="log-content">
                        {notifyMap[item.deviceId]}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            );
          }}
        />
      </View>
    </View>
  );
}
