import { useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { View, Text, Slider } from "@tarojs/components";
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
  const currentModeRef = useRef<string | null>(null); // 'LOOP' or modeKey

  // RSSI Limit State
  const [rssiThreshold, setRssiThreshold] = useState(-80);
  const rssiThresholdRef = useRef(-80);

  useEffect(() => {
    rssiThresholdRef.current = rssiThreshold;
  }, [rssiThreshold]);

  // RGBW Loop State
  const [isLooping, setIsLooping] = useState(false);
  const loopTimerRef = useRef<any>(null);
  const LOOP_COLORS = ["red", "green", "blue", "full"]; // Order: Red, Green, Blue, White

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
    red: {
      name: "红色灯光",
      color: "#ff4d4f", // Red
      hex: "55AA083700ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff00016464010000",
      bg: "linear-gradient(135deg, #ff7875 0%, #d9363e 100%)",
    },
    green: {
      name: "绿色灯光",
      color: "#52c41a", // Green
      hex: "55AA0837ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000016464010000",
      bg: "linear-gradient(135deg, #95de64 0%, #52c41a 100%)",
    },
    blue: {
      name: "蓝色灯光",
      color: "#2f54eb", // Geekblue
      hex: "55AA08370000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff016464010000",
      bg: "linear-gradient(135deg, #597ef7 0%, #2f54eb 100%)",
    },
  };

  useEffect(() => {
    autoConnectRef.current = autoConnectEnabled;
  }, [autoConnectEnabled]);

  useEffect(() => {
    return () => clearInterval(loopTimerRef.current);
  }, []);

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
            if (autoConnectRef.current && d.RSSI >= rssiThresholdRef.current) {
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

  /** ✅ CONNECT */
  const handleConnect = async (deviceId) => {
    if (connectedSet.current.has(deviceId)) return;

    await BLEService.connect(deviceId);
    connectedSet.current.add(deviceId);

    await enableNotify(deviceId);

    await enableNotify(deviceId);

    // Fix: Use ref to avoid stale closure issues in callbacks
    if (autoConnectRef.current && !writtenSet.current.has(deviceId)) {
      writtenSet.current.add(deviceId);

      const mode = currentModeRef.current;
      if (mode === "LOOP") {
        startLoop();
      } else if (mode && LIGHT_MODES[mode]) {
        // Apply current static color to the new device
        writeA951(deviceId, LIGHT_MODES[mode].hex);
      }
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

  /** ✅ START LOOP */
  const startLoop = () => {
    currentModeRef.current = "LOOP";
    if (loopTimerRef.current) return;

    setIsLooping(true);
    let idx = 0;
    writeMode(LOOP_COLORS[idx]);
    idx = (idx + 1) % LOOP_COLORS.length;

    loopTimerRef.current = setInterval(() => {
      writeMode(LOOP_COLORS[idx]);
      idx = (idx + 1) % LOOP_COLORS.length;
    }, 1000);
  };

  /** ✅ STOP LOOP */
  const stopLoop = () => {
    // Note: We don't clear currentModeRef here because we might want to stay on the last color
    // But for explicit manual control, we'll override it in handleManualMode
    if (loopTimerRef.current) {
      clearInterval(loopTimerRef.current);
      loopTimerRef.current = null;
    }
    setIsLooping(false);
  };

  /** ✅ MANUAL MODE CLICK */
  const handleManualModeClick = (key) => {
    stopLoop();
    currentModeRef.current = key;
    writeMode(key);
  };

  /** ✅ TOGGLE LOOP */
  const toggleLoop = () => {
    if (isLooping) {
      stopLoop();
    } else {
      startLoop();
    }
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

        {/* RSSI Threshold Slider */}
        <View
          className="rssi-setting-container"
          style={{ marginTop: "24px", padding: "0 4px" }}
        >
          <View
            className="label-row"
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "12px",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: "14px", color: "#333", fontWeight: 600 }}>
              自动连接信号阈值
            </Text>
            <Text
              style={{
                fontSize: "14px",
                color: "#1677ff",
                fontFamily: "monospace",
                fontWeight: "bold",
              }}
            >
              {rssiThreshold} dBm
            </Text>
          </View>
          <Slider
            min={-100}
            max={-40}
            step={1}
            value={rssiThreshold}
            activeColor="#1677ff"
            backgroundColor="#e6e6e6"
            blockSize={24}
            onChanging={(e) => setRssiThreshold(e.detail.value)}
            onChange={(e) => setRssiThreshold(e.detail.value)}
          />
          <Text
            style={{
              fontSize: "11px",
              color: "#999",
              marginTop: "8px",
              display: "block",
            }}
          >
            仅自动连接信号强于 {rssiThreshold} dBm 的设备
          </Text>
        </View>

        {/* Loop Control Button */}
        <View
          className="loop-btn"
          onClick={toggleLoop}
          style={{
            marginTop: "16px",
            padding: "14px",
            borderRadius: "12px",
            background: isLooping
              ? "linear-gradient(90deg, #ff4d4f, #52c41a, #2f54eb, #faad14)"
              : "#f5f5f5",
            color: isLooping ? "#fff" : "#666",
            textAlign: "center",
            fontWeight: "bold",
            fontSize: "14px",
            boxShadow: isLooping ? "0 4px 12px rgba(0,0,0,0.15)" : "none",
            transition: "all 0.3s ease",
          }}
        >
          {isLooping
            ? "🟥 🟩 🟦 ⬜ 循环运行中 (点击停止)"
            : "开启 RGBW 循环切换 (1s)"}
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
              onClick={() => handleManualModeClick(key)}
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
