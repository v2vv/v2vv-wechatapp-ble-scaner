import { useEffect, useState } from "react";
import BLEService from "../../lib/bluetooth/bleService";
import { Collapse, CollapseItem } from "@nutui/nutui-react-taro";

export default function Index() {
  const [deviceList, setDeviceList] = useState([]);
  const [connectedId, setConnectedId] = useState(null);
  const [serviceList, setServiceList] = useState([]);
  const [notifyValue, setNotifyValue] = useState("");

  // ✅ 每个特征的输入框内容
  const [writeInputs, setWriteInputs] = useState({});

  const updateWriteInput = (charId, value) => {
    setWriteInputs((prev) => ({
      ...prev,
      [charId]: value,
    }));
  };

  // ✅ 初始化 BLE
  useEffect(() => {
    async function initBLE() {
      await BLEService.initBluetooth();
      await BLEService.startDiscovery();

      BLEService.onDeviceFound((devices) => {
        setDeviceList((prev) => {
          let list = [...prev];

          devices.forEach((d) => {
            if (!d.name || !d.name.startsWith("632")) return;

            const exists = list.find((i) => i.deviceId === d.deviceId);
            if (!exists) list.push(d);
            else exists.RSSI = d.RSSI;
          });

          return list;
        });
      });

      BLEService.onDisconnect((deviceId) => {
        if (deviceId === connectedId) {
          setConnectedId(null);
          setServiceList([]);
          setNotifyValue("");
        }
      });
    }

    initBLE();
  }, []);

  // ✅ 每秒刷新 RSSI
  useEffect(() => {
    const timer = setInterval(() => {
      setDeviceList((prev) => [...prev].sort((a, b) => b.RSSI - a.RSSI));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // ✅ 判断系统服务
  const isSystemService = (uuid) => {
    uuid = uuid.toUpperCase();
    return uuid.startsWith("00001800") || uuid.startsWith("00001801");
  };

  // ✅ 连接设备
  const handleConnect = async (deviceId) => {
    await BLEService.connect(deviceId);
    setConnectedId(deviceId);

    const services = await BLEService.getServices(deviceId);
    const result = [];

    for (const s of services) {
      if (isSystemService(s.uuid)) continue;

      try {
        const chars = await BLEService.getCharacteristics(deviceId, s.uuid);

        result.push({
          serviceId: s.uuid,
          characteristics: chars,
        });
      } catch {}
    }

    setServiceList(result);

    // ✅ 自动开启 A950 Notify
    enableA950Notify(deviceId, result);
  };

  // ✅ 自动识别并开启 A950 Notify
  const enableA950Notify = async (deviceId, services) => {
    const svc = services.find((s) => s.serviceId.includes("FFF0"));
    if (!svc) return;

    const notifyChar = svc.characteristics.find((c) => c.uuid.includes("FFF1"));
    if (!notifyChar) return;

    await BLEService.notify(deviceId, svc.serviceId, notifyChar.uuid);
    console.log("✅ A950 Notify 已开启");
  };

  // ✅ 监听通知（更新悬浮窗）
  useEffect(() => {
    BLEService.onNotify((res) => {
      const hex = [...new Uint8Array(res.value)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(" ");

      console.log("📩 A950 通知:", hex);
      setNotifyValue(hex);
    });
  }, []);

  const sendA950Data = async (serviceId, charId) => {
    const hex = (writeInputs[charId] || "").replace(/\s+/g, "").toUpperCase();

    if (!hex) {
      console.log("⚠️ 输入为空");
      return;
    }

    if (hex.length % 2 !== 0) {
      console.log("❌ Hex 长度必须为偶数");
      return;
    }

    // ✅ 直接把 Hex 转成 ArrayBuffer（BLE 必须）
    const buffer = new ArrayBuffer(hex.length / 2);
    const dataView = new DataView(buffer);

    for (let i = 0; i < hex.length; i += 2) {
      dataView.setUint8(i / 2, parseInt(hex.substr(i, 2), 16));
    }

    await BLEService.write(serviceId, charId, buffer);

    console.log("✅ 已发送原始 Hex:", hex);
  };

  // ✅ 断开
  const handleDisconnect = async (deviceId) => {
    await BLEService.disconnect(deviceId);
    setConnectedId(null);
    setServiceList([]);
    setNotifyValue("");
  };

  return (
    <view>
      <view style={{ fontSize: "18px", fontWeight: "bold" }}>BLE 测试页面</view>

      {/* ✅ 设备列表 */}
      <view style={{ marginTop: "20px" }}>
        <view>扫描到的设备（632 开头）：</view>

        {deviceList.map((item) => {
          const isConnected = item.deviceId === connectedId;

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

      {/* ✅ 服务折叠展示 */}
      {connectedId && (
        <view style={{ marginTop: "20px" }}>
          <view>设备服务与特征：</view>

          {/* ✅ 整个服务列表可滚动 */}
          <scroll-view
            scroll-y
            style={{
              maxHeight: "60vh",
              border: "1px solid #eee",
              borderRadius: "8px",
              padding: "6px",
            }}
          >
            <Collapse defaultActiveName={[]}>
              {serviceList.map((s) => (
                <CollapseItem
                  key={s.serviceId}
                  title={`服务 UUID：${s.serviceId}`}
                  name={s.serviceId}
                >
                  {/* ✅ 特征列表也可滚动 */}
                  <scroll-view
                    scroll-y
                    style={{
                      maxHeight: "250px",
                      paddingRight: "10px",
                    }}
                  >
                    {s.characteristics.map((c) => (
                      <view key={c.uuid} style={{ padding: "10px 0" }}>
                        <view>特征 UUID：{c.uuid}</view>
                        <view>属性：{JSON.stringify(c.properties)}</view>

                        {/* ✅ 写入输入框 + 按钮 */}
                        {c.properties.write && (
                          <view style={{ marginTop: "10px" }}>
                            <input
                              style={{
                                width: "100%",
                                padding: "8px",
                                border: "1px solid #ccc",
                                borderRadius: "6px",
                                marginBottom: "8px",
                              }}
                              placeholder="输入 Hex（01 02 FF）或文本"
                              value={writeInputs[c.uuid] || ""}
                              onInput={(e) =>
                                updateWriteInput(c.uuid, e.detail.value)
                              }
                            />

                            <button
                              style={{
                                backgroundColor: "#1677ff",
                                color: "#fff",
                                padding: "6px 12px",
                                borderRadius: "6px",
                              }}
                              onClick={() => sendA950Data(s.serviceId, c.uuid)}
                            >
                              发送
                            </button>
                          </view>
                        )}
                      </view>
                    ))}
                  </scroll-view>
                </CollapseItem>
              ))}
            </Collapse>
          </scroll-view>
        </view>
      )}

      {/* ✅ 右下角悬浮窗显示通知值 */}
      {notifyValue && (
        <view
          style={{
            position: "fixed",
            bottom: "20px",
            right: "20px",
            backgroundColor: "rgba(0,0,0,0.75)",
            color: "#fff",
            padding: "10px 14px",
            borderRadius: "8px",
            fontSize: "14px",
            zIndex: 9999,
            maxWidth: "60%",
            wordBreak: "break-all",
          }}
        >
          通知：{notifyValue}
        </view>
      )}
    </view>
  );
}
