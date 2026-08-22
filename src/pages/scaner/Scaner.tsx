import { useEffect, useRef, useState, useMemo, useCallback } from "react";
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
  firstSeen: number;
}

export default function Index() {
  const [deviceList, setDeviceList] = useState<BLEDevice[]>([]);
  const [notifyMap, setNotifyMap] = useState<Record<string, string>>({});
  const [autoConnectEnabled, setAutoConnectEnabled] = useState(false);
  const [autoModeRunning, setAutoModeRunning] = useState(false);

  const [whiteMode, setWhiteMode] = useState<string | null>(null);

  const connectedSet = useRef<Set<string>>(new Set());
  const connectingSet = useRef<Set<string>>(new Set());
  const connectQueueRef = useRef<string[]>([]);
  const isProcessingQueueRef = useRef(false);

  const writtenSet = useRef<Set<string>>(new Set());
  const autoConnectRef = useRef(false);
  const currentModeRef = useRef<string | null>(null); // 'LOOP' or modeKey

  // 内存设备池与动态节流控制
  const deviceMapRef = useRef<Map<string, BLEDevice>>(new Map());
  const lastUpdateTimeMapRef = useRef<Map<string, number>>(new Map());
  const isDirtyRef = useRef(false);

  // RSSI Limit State
  const [rssiThreshold, setRssiThreshold] = useState(-58);
  const rssiThresholdRef = useRef(-58);

  useEffect(() => {
    rssiThresholdRef.current = rssiThreshold;
  }, [rssiThreshold]);

  // RGBW Loop State
  const [isLooping, setIsLooping] = useState(false);
  const loopTimerRef = useRef<any>(null);
  const LOOP_COLORS = ["red", "green", "blue", "full"]; // Order: Red, Green, Blue, White

  /** ✅ LIGHT MODE COMMANDS */
  const LIGHT_MODES: Record<
    string,
    { name: string; color: string; hex: string; bg: string }
  > = {
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
      hex: "55AA020B03010000000000006464000000",
      bg: "linear-gradient(135deg, #f759ab 0%, #722ed1 100%)",
    },
    red: {
      name: "红色灯光",
      color: "#ff4d4f", // Red
      hex: "55AA083700ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff00016464010000",
      bg: "linear-gradient(135deg, #ff7875 0%, #d9363e 100%)",
    },
    green: {
      name: "绿色灯光",
      color: "#52c41a", // Green
      hex: "55AA0837ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000016464010000",
      bg: "linear-gradient(135deg, #95de64 0%, #52c41a 100%)",
    },
    blue: {
      name: "蓝色灯光",
      color: "#2f54eb", // Geekblue
      hex: "55AA08370000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff0000ff016464010000",
      bg: "linear-gradient(135deg, #597ef7 0%, #2f54eb 100%)",
    },
  };

  useEffect(() => {
    autoConnectRef.current = autoConnectEnabled;
  }, [autoConnectEnabled]);

  useEffect(() => {
    return () => {
      if (loopTimerRef.current) clearInterval(loopTimerRef.current);
    };
  }, []);

  /**
   * 辅助函数：将 16 进制字符串转换为 ArrayBuffer
   */
  const parseHexBuffer = (hex: string): ArrayBuffer => {
    const matches = hex.match(/.{2}/g) || [];
    return new Uint8Array(matches.map((b) => parseInt(b, 16))).buffer;
  };

  /**
   * 🌟 动态计算基于信号强度的更新节流时间 (ms)
   */
  const getThrottleInterval = (rssi: number) => {
    if (rssi >= -65) return 350; // 强信号：350ms 极速响应
    if (rssi >= -80) return 1200; // 中等信号：1.2s 适度刷新
    if (rssi >= -95) return 3500; // 弱信号：3.5s 低频刷新
    return 6000; // 极弱噪声：6s 极低频刷新
  };

  /**
   * 🌟 批量同步设备列表到 React 状态（按信号强度优先排序）
   */
  const flushDeviceList = useCallback(() => {
    if (!isDirtyRef.current) return;
    isDirtyRef.current = false;

    // 智能优先级排序：
    // 1. 已连接置顶
    // 2. 强信号排前 (RSSI 降序)
    // 3. 相同信号下新设备排前
    const list = Array.from(deviceMapRef.current.values()).sort((a, b) => {
      const aConn = connectedSet.current.has(a.deviceId);
      const bConn = connectedSet.current.has(b.deviceId);
      if (aConn && !bConn) return -1;
      if (!aConn && bConn) return 1;
      if (b.RSSI !== a.RSSI) return b.RSSI - a.RSSI;
      return b.lastSeen - a.lastSeen;
    });

    setDeviceList(list);
  }, []);

  /**
   * 🌟 快速连接队列处理器 (Fast Serial Connection Pipeline)
   * 避免并发 GATT 冲突，单设备高效握手（~150ms-300ms），连接完成立即可用
   */
  const processConnectQueue = async () => {
    if (isProcessingQueueRef.current) return;
    isProcessingQueueRef.current = true;

    while (connectQueueRef.current.length > 0) {
      if (connectedSet.current.size >= 8) {
        Taro.showToast({
          title: "已达到最大连接数 (8)",
          icon: "none",
        });
        connectQueueRef.current = [];
        break;
      }

      const nextDeviceId = connectQueueRef.current.shift()!;
      if (connectedSet.current.has(nextDeviceId)) {
        connectingSet.current.delete(nextDeviceId);
        continue;
      }

      try {
        // 暂停扫描以全功率加速当前 GATT 连接握手
        await Taro.stopBluetoothDevicesDiscovery();

        // 极速建立连接 + 协商 MTU + 单次获取特征缓存 + 开启 Notify
        await BLEService.fastConnectAndSetup(nextDeviceId, 3500);
        connectedSet.current.add(nextDeviceId);

        // 如果在自动连接模式下，且尚未发送过初始指令，极速下发
        if (autoConnectRef.current && !writtenSet.current.has(nextDeviceId)) {
          writtenSet.current.add(nextDeviceId);

          const mode = currentModeRef.current;
          if (mode === "LOOP") {
            startLoop();
          } else if (mode && LIGHT_MODES[mode]) {
            const buf = parseHexBuffer(LIGHT_MODES[mode].hex);
            await BLEService.fastWrite(nextDeviceId, buf);
          }
        }

        isDirtyRef.current = true;
        flushDeviceList();
      } catch (err) {
        console.warn("⚡ 连接失败:", nextDeviceId, err);
        removeDevice(nextDeviceId);
      } finally {
        connectingSet.current.delete(nextDeviceId);
        // 连接完成后，立即恢复高灵敏度扫描
        await BLEService.startDiscovery();
      }
    }

    isProcessingQueueRef.current = false;
  };

  /** ✅ 发起连接（入队调度） */
  const handleConnect = (deviceId: string) => {
    if (
      connectedSet.current.has(deviceId) ||
      connectingSet.current.has(deviceId)
    ) {
      return;
    }
    connectingSet.current.add(deviceId);
    connectQueueRef.current.push(deviceId);
    processConnectQueue();
  };

  /** ✅ BLE INIT & SMART DISCOVERY */
  const initBLE = async () => {
    await BLEService.initBluetooth();
    await BLEService.startDiscovery();

    BLEService.onDisconnect((deviceId) => removeDevice(deviceId));

    BLEService.onDeviceFound((devices) => {
      const now = Date.now();
      let hasNewDevice = false;

      devices.forEach((d) => {
        if (!d.name?.startsWith("632")) return;

        const id = d.deviceId;
        const existing = deviceMapRef.current.get(id);
        const lastUpdated = lastUpdateTimeMapRef.current.get(id) || 0;

        if (!existing) {
          // 🚀 1. 重点捕获新设备：0 延迟立即录入
          const newDev: BLEDevice = {
            deviceId: id,
            name: d.name,
            RSSI: d.RSSI,
            lastSeen: now,
            missCount: 0,
            firstSeen: now,
          };

          deviceMapRef.current.set(id, newDev);
          lastUpdateTimeMapRef.current.set(id, now);
          hasNewDevice = true;
          isDirtyRef.current = true;

          // 自动连接逻辑：新设备如果达到信号阈值，0ms 极速进入连接队列！
          if (autoConnectRef.current && d.RSSI >= rssiThresholdRef.current) {
            handleConnect(id);
          }
        } else {
          // 🚀 2. 已有设备：分级节流控制
          const oldRssi = existing.RSSI;
          const rssiJump = d.RSSI - oldRssi;
          const throttleInterval = getThrottleInterval(d.RSSI);
          const timeElapsed = now - lastUpdated;
          const isConnected = connectedSet.current.has(id);

          existing.lastSeen = now;
          existing.missCount = 0;

          if (
            timeElapsed >= throttleInterval ||
            rssiJump >= 10 ||
            (isConnected && timeElapsed >= 500)
          ) {
            existing.RSSI = d.RSSI;
            existing.name = d.name || existing.name;
            lastUpdateTimeMapRef.current.set(id, now);
            isDirtyRef.current = true;

            // 若设备原先较弱，靠近变强后达到阈值且开启自动连接，立即入队连接
            if (
              autoConnectRef.current &&
              !connectedSet.current.has(id) &&
              oldRssi < rssiThresholdRef.current &&
              d.RSSI >= rssiThresholdRef.current
            ) {
              handleConnect(id);
            }
          }
        }
      });

      if (hasNewDevice) {
        flushDeviceList();
      }
    });

    BLEService.onNotify((res) => {
      const hex = [...new Uint8Array(res.value)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(" ");

      setNotifyMap((prev) => ({ ...prev, [res.deviceId]: hex }));
    });
  };

  useEffect(() => {
    initBLE();
  }, []);

  /**
   * 🌟 定时批量合并刷新 UI，避免高频 setData
   */
  useEffect(() => {
    const timer = setInterval(() => {
      flushDeviceList();
    }, 250);

    return () => clearInterval(timer);
  }, [flushDeviceList]);

  /**
   * 🌟 分级老化与弱设备快速淘汰机制
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      let changed = false;

      deviceMapRef.current.forEach((d, id) => {
        if (connectedSet.current.has(id)) return;

        const isWeak = d.RSSI < -85;
        const checkTimeout = isWeak ? 2000 : 3000;
        const maxMiss = isWeak ? 2 : 3;

        if (now - d.lastSeen > checkTimeout) {
          d.missCount++;
        }

        if (d.missCount >= maxMiss) {
          deviceMapRef.current.delete(id);
          lastUpdateTimeMapRef.current.delete(id);
          removeDevice(id);
          changed = true;
        }
      });

      if (changed) {
        isDirtyRef.current = true;
        flushDeviceList();
      }
    }, 1500);

    return () => clearInterval(timer);
  }, [flushDeviceList]);

  /** ✅ RSSI CHECK & REAL-TIME UPDATE FOR CONNECTED DEVICES */
  useEffect(() => {
    const timer = setInterval(async () => {
      if (connectedSet.current.size === 0) return;
      let changed = false;

      for (const deviceId of Array.from(connectedSet.current)) {
        try {
          const res = await Taro.getBLEDeviceRSSI({ deviceId });
          if (res && typeof res.RSSI === "number") {
            const dev = deviceMapRef.current.get(deviceId);
            if (dev && dev.RSSI !== res.RSSI) {
              dev.RSSI = res.RSSI;
              dev.lastSeen = Date.now();
              changed = true;
            }
          }
        } catch (err) {
          console.warn("⚠️ 获取已连接设备 RSSI 失败，可能已断开:", deviceId, err);
          removeDevice(deviceId);
        }
      }

      if (changed) {
        isDirtyRef.current = true;
        flushDeviceList();
      }
    }, 1200);

    return () => clearInterval(timer);
  }, [flushDeviceList]);

  /** ✅ REMOVE DEVICE */
  const removeDevice = (deviceId: string) => {
    connectedSet.current.delete(deviceId);
    connectingSet.current.delete(deviceId);
    writtenSet.current.delete(deviceId);
    deviceMapRef.current.delete(deviceId);
    lastUpdateTimeMapRef.current.delete(deviceId);

    connectQueueRef.current = connectQueueRef.current.filter(
      (id) => id !== deviceId
    );

    setNotifyMap((prev) => {
      if (!prev[deviceId]) return prev;
      const m = { ...prev };
      delete m[deviceId];
      return m;
    });

    isDirtyRef.current = true;
    flushDeviceList();
  };

  /** ✅ 极速模式切换 (直接利用内存缓存，0ms GATT 探测耗时) */
  const writeMode = async (modeKey: string) => {
    const mode = LIGHT_MODES[modeKey];
    if (!mode) return;

    const buffer = parseHexBuffer(mode.hex);
    const tasks: Promise<any>[] = [];
    for (const deviceId of connectedSet.current) {
      tasks.push(
        BLEService.fastWrite(deviceId, buffer).catch((err) => {
          console.log("Write error:", deviceId, err);
        })
      );
    }

    await Promise.all(tasks);
    setWhiteMode(modeKey);
  };

  /** ✅ TOGGLE AUTO MODE */
  const toggleAutoMode = async () => {
    if (!autoModeRunning) {
      setAutoModeRunning(true);
      setAutoConnectEnabled(true);

      const targets = Array.from(deviceMapRef.current.values()).filter(
        (dev) =>
          dev.name?.startsWith("632") &&
          dev.RSSI >= rssiThresholdRef.current &&
          !connectedSet.current.has(dev.deviceId)
      );

      for (const dev of targets) {
        handleConnect(dev.deviceId);
      }
    } else {
      setAutoModeRunning(false);
      setAutoConnectEnabled(false);
      connectQueueRef.current = [];

      for (const deviceId of Array.from(connectedSet.current)) {
        try {
          await BLEService.disconnect(deviceId);
        } catch {}
        removeDevice(deviceId);
      }
    }
  };

  /** ✅ DISCONNECT */
  const handleDisconnect = async (deviceId: string) => {
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
    }, 500);
  };

  /** ✅ STOP LOOP */
  const stopLoop = () => {
    if (loopTimerRef.current) {
      clearInterval(loopTimerRef.current);
      loopTimerRef.current = null;
    }
    setIsLooping(false);
  };

  /** ✅ MANUAL MODE CLICK */
  const handleManualModeClick = (key: string) => {
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

  // 统计当前强信号设备数量 (>= -65 dBm)
  const strongCount = useMemo(() => {
    return deviceList.filter((d) => d.RSSI >= -65).length;
  }, [deviceList]);

  // 过滤显示列表
  const filteredList = useMemo(() => {
    return deviceList.filter(
      (d) => d.RSSI >= rssiThreshold || connectedSet.current.has(d.deviceId)
    );
  }, [deviceList, rssiThreshold]);

  return (
    <View className="scaner-page">
      {/* Header Section */}
      <View className="header">
        <View className="title">BLE Device Manager</View>
        <View className="subtitle">多设备极速连接 & 智能分级控制</View>
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
              {autoModeRunning ? "正在极速自动连接与配置..." : "手动模式"}
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
            min={-120}
            max={-40}
            step={1}
            value={rssiThreshold}
            activeColor="#1677ff"
            backgroundColor="#e6e6e6"
            blockSize={24}
            onChanging={(e) => setRssiThreshold(e.detail.value)}
            onChange={(e) => setRssiThreshold(e.detail.value)}
          />
          <View
            style={{
              display: "flex",
              justifyContent: "space-around",
              marginTop: "16px",
              marginBottom: "8px",
            }}
          >
            {[
              { label: "宽松 -92", value: -92 },
              { label: "适中 -75", value: -75 },
              { label: "极好 -58", value: -58 },
            ].map((preset) => (
              <View
                key={preset.value}
                onClick={() => setRssiThreshold(preset.value)}
                style={{
                  padding: "6px 14px",
                  borderRadius: "16px",
                  fontSize: "12px",
                  fontWeight: "600",
                  backgroundColor:
                    rssiThreshold === preset.value ? "#1677ff" : "#f0f2f5",
                  color: rssiThreshold === preset.value ? "#fff" : "#666",
                  boxShadow:
                    rssiThreshold === preset.value
                      ? "0 2px 8px rgba(22, 119, 255, 0.3)"
                      : "none",
                  transition: "all 0.3s ease",
                }}
              >
                {preset.label}
              </View>
            ))}
          </View>

          <Text
            style={{
              fontSize: "11px",
              color: "#999",
              marginTop: "8px",
              display: "block",
              textAlign: "center",
            }}
          >
            仅自动连接信号强于 {rssiThreshold} dBm 的设备 (新设备与强信号优先极速接入)
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
            : "开启 RGBW 循环切换 (0.5s)"}
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
          <View>
            发现: {deviceList.length} (强信号: {strongCount})
          </View>
          <View>已连接: {Array.from(connectedSet.current).length}</View>
        </View>

        <VirtualList
          list={filteredList}
          itemHeight={110}
          height={380}
          itemRender={(item: BLEDevice) => {
            const isConnected = connectedSet.current.has(item.deviceId);
            const isConnecting = connectingSet.current.has(item.deviceId);
            const rssiLevel =
              item.RSSI >= -65 ? "good" : item.RSSI >= -80 ? "fair" : "poor";
            const rssiLabel =
              item.RSSI >= -65
                ? "强信号"
                : item.RSSI >= -80
                ? "中等"
                : "弱信号";
            const isJustDiscovered = Date.now() - (item.firstSeen || 0) < 5000;

            return (
              <View className="device-item-container" key={item.deviceId}>
                <View
                  className={`device-card ${isConnected ? "connected" : ""}`}
                >
                  <View className="card-top">
                    <View className="device-info">
                      <View className="icon-box">
                        <Text>
                          {isConnected ? "🔗" : isConnecting ? "⏳" : "📡"}
                        </Text>
                      </View>
                      <View className="text-info">
                        <View className="name-row">
                          <View className="name">
                            {item.name || "Unknown Device"}
                          </View>
                          {isJustDiscovered && (
                            <View className="new-badge">NEW</View>
                          )}
                        </View>
                        <View className="id">{item.deviceId}</View>
                      </View>
                    </View>
                    <View className={`rssi-box ${rssiLevel}`}>
                      <Text>📶 {item.RSSI} dBm</Text>
                      <View className="signal-tag">{rssiLabel}</View>
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
                        style={{
                          opacity: isConnecting ? 0.7 : 1,
                        }}
                        onClick={() => handleConnect(item.deviceId)}
                      >
                        {isConnecting ? "正在快速连接..." : "连接设备"}
                      </View>
                    )}
                  </View>
                </View>
              </View>
            );
          }}
        />
      </View>
    </View>
  );
}
