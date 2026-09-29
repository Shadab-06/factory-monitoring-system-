import { useEffect, useMemo, useRef, useState } from "react";

import "./App.css";



const DEFAULT_MOTORS = [

  { id: 1, name: "BASE", angle: 90 },

  { id: 2, name: "SHOULDER", angle: 75 },

  { id: 3, name: "ELBOW", angle: 70 },

  { id: 4, name: "GRIPPER", angle: 90 },

];



function App() {

  const [motors, setMotors] = useState(DEFAULT_MOTORS);



  const [temperature, setTemperature] = useState(29.7);

  const [vibration, setVibration] = useState(0.17);



  const [overheatAlert, setOverheatAlert] = useState(false);



  const [joysticks, setJoysticks] = useState({
    j1x: 2048,
    j1y: 2048,
    j2x: 2048,
    j2y: 2048,
  });

  const [axes, setAxes] = useState({ ax: 0, ay: 0, az: 1 });



  const [gripper, setGripper] = useState("OPEN");

  const [emergencyStop, setEmergencyStop] = useState(false);

  const [espOnline, setEspOnline] = useState(false);
  const [controlMode, setControlMode] = useState("DASHBOARD");
  const serialPortRef = useRef(null);
  const serialReaderRef = useRef(null);
  const serialWriteChainRef = useRef(Promise.resolve());



  const [recovery, setRecovery] = useState(false);

  const [recoveryStep, setRecoveryStep] = useState("");

  // =====================================================
  // MAINTENANCE MONITOR
  // =====================================================
  const [machineRuntime, setMachineRuntime] = useState(0);
  const [movementCycles, setMovementCycles] = useState(0);
  const [maintenanceAcknowledged, setMaintenanceAcknowledged] = useState(false);
  const lastServiceDate = "15 SEP 2026";



  const [history, setHistory] = useState(() =>

    Array.from({ length: 24 }, (_, i) => ({

      temperature: 28 + Math.random() * 3,

      vibration: 0.08 + Math.random() * 0.08,

      time: i,

    }))

  );



  const [events, setEvents] = useState([

    {

      time: new Date().toLocaleTimeString(),

      type: "SYSTEM",

      message: "SCADA control center initialized",

    },

    {

      time: new Date().toLocaleTimeString(),

      type: "SENSOR",

      message: "DS18B20 + MPU6050 monitoring active on Motor 1 / Base",

    },

  ]);



  const addEvent = (type, message) => {

    setEvents((old) => [

      {

        time: new Date().toLocaleTimeString(),

        type,

        message,

      },

      ...old,

    ].slice(0, 15));

  };



  const temperatureStatus = useMemo(() => {

  if (overheatAlert || temperature >= 80) {

    return {

      level: "critical",

      label: "OVERHEAT",

      message: "Critical temperature detected",

    };

  }



  if (temperature >= 70) {

    return {

      level: "critical",

      label: "CRITICAL",

      message: "Temperature above critical limit",

    };

  }



  if (temperature >= 60) {

    return {

      level: "warning",

      label: "HIGH",

      message: "Temperature requires attention",

    };

  }



  if (temperature >= 45) {

    return {

      level: "warning",

      label: "WARNING",

      message: "Temperature rising",

    };

  }



  return {

    level: "normal",

    label: "NORMAL",

    message: "Operating within normal range",

  };

}, [temperature, overheatAlert]);



  // =====================================================
  // REAL ESP32 SERIAL DATA (READ ONLY)
  // =====================================================
  const processSerialLine = (line) => {
    const clean = line.trim();
    if (!clean) return;
    const match = clean.match(/^([A-Z0-9]+):\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return;
    const key = match[1];
    const value = Number(match[2]);
    switch (key) {
      case "TEMP": if (Number.isFinite(value)) setTemperature(value); break;
      case "VIB": if (Number.isFinite(value)) setVibration(value); break;
      case "AX": setAxes((old) => ({ ...old, ax: value })); break;
      case "AY": setAxes((old) => ({ ...old, ay: value })); break;
      case "AZ": setAxes((old) => ({ ...old, az: value })); break;
      case "J1X": case "J1Y": case "J2X": case "J2Y":
        setJoysticks((old) => ({ ...old, [key.toLowerCase()]: value })); break;
      case "S1": case "S2": case "S3": case "S4": {
        const id = Number(key.substring(1));
        setMotors((old) => old.map((motor) => motor.id === id
          ? { ...motor, angle: Math.max(0, Math.min(180, Math.round(value))) }
          : motor));
        break;
      }
      default: break;
    }
  };

  const queueSerialCommand = (command) => {
    const port = serialPortRef.current;
    if (!port?.writable) return false;

    serialWriteChainRef.current = serialWriteChainRef.current
      .then(async () => {
        const writer = port.writable.getWriter();
        try {
          await writer.write(new TextEncoder().encode(`${command}\n`));
        } finally {
          writer.releaseLock();
        }
      })
      .catch((error) => {
        addEvent("ERROR", `Serial command failed: ${error.message}`);
      });

    return true;
  };

  const changeControlMode = (mode) => {
    if (emergencyStop || recovery) return;
    setControlMode(mode);
    if (espOnline) {
      queueSerialCommand(`MODE:${mode}`);
    }
    addEvent("CONTROL", `Control authority changed to ${mode}`);
  };

  const disconnectESP32 = async (log = true) => {
    try {
      if (serialReaderRef.current) {
        await serialReaderRef.current.cancel();
        serialReaderRef.current = null;
      }
      if (serialPortRef.current) {
        await serialPortRef.current.close();
        serialPortRef.current = null;
      }
    } catch (error) {
      if (log) addEvent("ERROR", `Serial disconnect error: ${error.message}`);
    } finally {
      setEspOnline(false);
      if (log) addEvent("SYSTEM", "ESP32 disconnected");
    }
  };

  const connectESP32 = async () => {
    if (!("serial" in navigator)) {
      addEvent("ERROR", "Web Serial is not supported — use Chrome or Edge");
      return;
    }
    if (serialPortRef.current) {
      await disconnectESP32();
      return;
    }
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      serialPortRef.current = port;
      setEspOnline(true);
      addEvent("SYSTEM", "ESP32 connected — serial stream active at 115200 baud");
      queueSerialCommand(`MODE:${controlMode}`);
      const decoder = new TextDecoderStream();
      port.readable.pipeTo(decoder.writable).catch(() => {});
      const reader = decoder.readable.getReader();
      serialReaderRef.current = reader;
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach(processSerialLine);
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        setEspOnline(false);
        addEvent("ERROR", `ESP32 serial connection failed: ${error.message}`);
      }
    } finally {
      serialReaderRef.current = null;
      serialPortRef.current = null;
      setEspOnline(false);
    }
  };

  useEffect(() => {
    return () => {
      if (serialReaderRef.current) serialReaderRef.current.cancel().catch(() => {});
      if (serialPortRef.current) serialPortRef.current.close().catch(() => {});
    };
  }, []);



  useEffect(() => {

    if (emergencyStop || recovery) return;



    const interval = setInterval(() => {

      setHistory((old) => [

        ...old.slice(-23),

        {

          temperature,

          vibration,

          time: Date.now(),

        },

      ]);

    }, 1500);



    return () => clearInterval(interval);

  }, [temperature, vibration, emergencyStop, recovery]);



  useEffect(() => {
    if (emergencyStop) return;

    const interval = setInterval(() => {
      setMachineRuntime((old) => old + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [emergencyStop]);

  const runtimeHours = Math.floor(machineRuntime / 3600);
  const runtimeMinutes = Math.floor((machineRuntime % 3600) / 60);

  const maintenanceStatus = useMemo(() => {
    if (temperature >= 80 || vibration >= 0.65) {
      return { level: "critical", label: "SERVICE REQUIRED", message: "Critical condition detected" };
    }

    if (temperature >= 60 || vibration >= 0.40) {
      return { level: "warning", label: "INSPECTION REQUIRED", message: "Condition requires inspection" };
    }

    if (temperature >= 45 || vibration >= 0.25) {
      return { level: "watch", label: "MONITOR", message: "Keep monitoring operating condition" };
    }

    return { level: "normal", label: "HEALTHY", message: "Operating condition is normal" };
  }, [temperature, vibration]);

  const maintenanceHealthIndex =
    maintenanceStatus.level === "normal" ? 98 :
    maintenanceStatus.level === "watch" ? 82 :
    maintenanceStatus.level === "warning" ? 61 : 28;

  const updateMotor = (id, value) => {

    if (emergencyStop || recovery) return;



    const angle = Math.max(0, Math.min(180, Number(value)));
    if (id === 4) setGripper(angle >= 90 ? "OPEN" : "CLOSED");



    setMotors((old) =>

      old.map((motor) =>

        motor.id === id ? { ...motor, angle } : motor

      )

    );

    if (controlMode === "DASHBOARD" && espOnline) {
      queueSerialCommand(`SET:S${id}:${angle}`);
    }

    addEvent("SERVO", `Motor ${id} moved to ${angle}°`);

    setMovementCycles((old) => old + 1);

  };



  const moveVirtualJoystick = (joystickName, x, y) => {
    if (emergencyStop || recovery || controlMode !== "JOYSTICK") return;

    const safeX = Math.max(0, Math.min(4095, Math.round(x)));
    const safeY = Math.max(0, Math.min(4095, Math.round(y)));

    setJoysticks((old) => ({
      ...old,
      ...(joystickName === "JOYSTICK 1"
        ? { j1x: safeX, j1y: safeY }
        : { j2x: safeX, j2y: safeY }),
    }));

    const xAngle = Math.round((safeX / 4095) * 180);
    const yAngle = Math.round((safeY / 4095) * 180);
    const motorIds = joystickName === "JOYSTICK 1" ? [1, 2] : [3, 4];
    const commands = [
      `SET:S${motorIds[0]}:${xAngle}`,
      `SET:S${motorIds[1]}:${yAngle}`,
    ];

    if (espOnline) {
      commands.forEach(queueSerialCommand);
    }

    setMotors((old) => old.map((motor) => {
      if (motor.id === motorIds[0]) return { ...motor, angle: xAngle };
      if (motor.id === motorIds[1]) return { ...motor, angle: yAngle };
      return motor;
    }));
  };

  const goHome = () => {

    if (emergencyStop || recovery) return;



    setMotors([

      { id: 1, name: "BASE", angle: 90 },

      { id: 2, name: "SHOULDER", angle: 90 },

      { id: 3, name: "ELBOW", angle: 90 },

      { id: 4, name: "GRIPPER", angle: 0 },

    ]);

    setGripper("CLOSED");

    if (controlMode === "DASHBOARD" && espOnline) {
      [1, 2, 3].forEach((id) => queueSerialCommand(`SET:S${id}:90`));
      queueSerialCommand("SET:S4:0");
    }

    addEvent("ARM", "Arm commanded to HOME position");

  };



  const openGripper = () => {

    if (emergencyStop || recovery) return;



    setGripper("OPEN");
    setMotors((old) => old.map((motor) => motor.id === 4 ? { ...motor, angle: 180 } : motor));
    if (controlMode === "DASHBOARD" && espOnline) queueSerialCommand("SET:S4:180");
    addEvent("GRIPPER", "Gripper OPEN command · S4 → 180°");

  };



  const closeGripper = () => {

    if (emergencyStop || recovery) return;



    setGripper("CLOSED");
    setMotors((old) => old.map((motor) => motor.id === 4 ? { ...motor, angle: 0 } : motor));
    if (controlMode === "DASHBOARD" && espOnline) queueSerialCommand("SET:S4:0");
    addEvent("GRIPPER", "Gripper CLOSE command · S4 → 0°");

  };



  const triggerEmergencyStop = () => {

    setEmergencyStop(true);

    setRecovery(false);

    setRecoveryStep("");



    queueSerialCommand("ESTOP:1");

    addEvent(

      "E-STOP",

      "Emergency stop activated — all commands locked"

    );

  };



  const resetSystem = () => {

    setEmergencyStop(false);

    setRecovery(false);

    setRecoveryStep("");
    queueSerialCommand("ESTOP:0");
    queueSerialCommand(`MODE:${controlMode}`);



    addEvent(

      "SYSTEM",

      "Emergency stop cleared — system ready"

    );

  };



  /*

   * Demonstration of controlled recovery.

   * Actual servo movement will be implemented in ESP32 firmware

   * only after physical safe positions are verified.

   */

  const startSafeRecovery = () => {

    if (emergencyStop || recovery) return;



    setRecovery(true);

    addEvent(

      "SAFETY",

      "Controlled safe recovery sequence initiated"

    );



    setRecoveryStep("LOCKING COMMANDS");



    setTimeout(() => {

      setRecoveryStep("MOVING TO SAFE RELEASE POSITION");



      addEvent(

        "SAFETY",

        "Moving arm toward predefined safe release position"

      );

    }, 1200);



    setTimeout(() => {

      setRecoveryStep("RELEASING OBJECT");

      setGripper("OPEN");



      addEvent(

        "SAFETY",

        "Gripper OPEN — object release stage"

      );

    }, 2600);



    setTimeout(() => {

      setRecoveryStep("RETURNING TO HOME");



      setMotors([

        { id: 1, name: "BASE", angle: 90 },

        { id: 2, name: "SHOULDER", angle: 90 },

        { id: 3, name: "ELBOW", angle: 90 },

        { id: 4, name: "GRIPPER", angle: 90 },

      ]);



      addEvent(

        "SAFETY",

        "Arm returning to predefined HOME position"

      );

    }, 4000);



    setTimeout(() => {

      setRecoveryStep("SYSTEM LOCKED");

      setEmergencyStop(true);

      setRecovery(false);



      addEvent(

        "SAFETY",

        "Safe recovery complete — system locked"

      );

    }, 5600);

  };



  const simulateOverheat = () => {

  if (emergencyStop || recovery) return;



  setTemperature(82);

  setOverheatAlert(true);



  addEvent(

    "CRITICAL",

    "MOTOR 1 OVERHEAT ALERT LATCHED — operator action required"

  );

};



  const clearTestTemperature = () => {

  if (emergencyStop || recovery) return;



  setTemperature(29.7);

  setOverheatAlert(false);



  addEvent(

    "SYSTEM",

    "Overheat alert cleared — Motor 1 temperature normal"

  );

};

useEffect(() => {

  if (temperature >= 80 && !overheatAlert) {

    setOverheatAlert(true);



    addEvent(

      "CRITICAL",

      `MOTOR 1 OVERHEAT DETECTED — ${temperature.toFixed(1)}°C`

    );

  }

}, [temperature, overheatAlert]);



  const dashboardCritical =

    emergencyStop ||

    overheatAlert ||

    temperatureStatus.level === "critical";



  return (

    <div

      className={`app ${

        dashboardCritical ? "critical-dashboard" : ""

      }`}

    >
      <style>{`
        .maintenance-section{margin-top:48px;margin-bottom:48px}.maintenance-header{margin-bottom:18px}.maintenance-status{min-width:175px;min-height:42px;padding:0 15px;display:flex;align-items:center;justify-content:center;gap:8px;border-radius:12px;font-family:Consolas,monospace;font-size:9px;font-weight:800;letter-spacing:1px}.maintenance-status-dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor}.maintenance-status.normal{color:#61f2a1;background:rgba(45,220,125,.06);border:1px solid rgba(74,235,148,.25)}.maintenance-status.watch{color:#5ee8f3;background:rgba(36,223,241,.06);border:1px solid rgba(36,223,241,.25)}.maintenance-status.warning{color:#ffc34f;background:rgba(255,190,50,.06);border:1px solid rgba(255,190,50,.3)}.maintenance-status.critical{color:#ff5b5b;background:rgba(255,40,40,.08);border:1px solid rgba(255,50,50,.45);animation:maintenancePulse 1s infinite}@keyframes maintenancePulse{50%{box-shadow:0 0 28px rgba(255,0,0,.18)}}.maintenance-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}.maintenance-card{min-height:235px;padding:22px;position:relative;overflow:hidden;border-radius:21px;border:1px solid rgba(65,155,175,.17);background:linear-gradient(145deg,rgba(17,29,38,.94),rgba(7,13,19,.96));box-shadow:0 18px 50px rgba(0,0,0,.23),inset 0 1px 0 rgba(255,255,255,.025);transition:.3s ease}.maintenance-card:hover{transform:translateY(-5px);border-color:rgba(35,224,242,.38)}.maintenance-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.maintenance-label{display:block;margin-bottom:7px;color:#536b76;font-family:Consolas,monospace;font-size:8px;letter-spacing:1.4px}.maintenance-card h3{margin:0;color:#cde5eb;font-size:13px}.health-indicator{width:30px;height:30px;display:grid;place-items:center;border-radius:9px}.health-indicator.normal{color:#61f2a1;background:rgba(45,220,125,.07)}.health-indicator.watch{color:#5ee8f3;background:rgba(36,223,241,.07)}.health-indicator.warning{color:#ffc34f;background:rgba(255,190,50,.07)}.health-indicator.critical{color:#ff5b5b;background:rgba(255,40,40,.09)}.health-score{margin-top:23px}.health-score-value{color:#68efaa;font:800 50px/1 Consolas,monospace}.health-score span{display:block;margin-top:7px;color:#536b76;font:8px Consolas,monospace;letter-spacing:1.4px}.health-message{margin-top:20px;color:#7f969f;font-size:10px;line-height:1.5}.maintenance-metric{margin-top:23px;color:#ffb74d;font:800 38px Consolas,monospace}.maintenance-metric small{color:#6f858e;font-size:12px;font-weight:500}.maintenance-icon{min-width:34px;height:34px;display:grid;place-items:center;border-radius:9px;font:800 9px Consolas,monospace}.temperature-icon{color:#ffb74d;background:rgba(255,170,50,.08)}.vibration-icon{color:#5ee8f3;background:rgba(36,223,241,.08)}.maintenance-range{height:5px;margin-top:18px;overflow:hidden;border-radius:10px;background:rgba(255,255,255,.06)}.maintenance-range-fill{height:100%;border-radius:inherit;transition:width .5s ease}.temperature-fill{background:linear-gradient(90deg,#61f2a1,#ffc34f,#ff5b5b)}.vibration-fill{background:linear-gradient(90deg,#61f2a1,#5ee8f3,#ff5b5b)}.maintenance-range-labels{display:flex;justify-content:space-between;margin-top:7px;color:#455c66;font:7px Consolas,monospace}.maintenance-condition{display:flex;justify-content:space-between;margin-top:20px;color:#506771;font:8px Consolas,monospace}.maintenance-condition strong{color:#61f2a1}.service-details{display:grid;gap:12px;margin-top:19px}.service-details>div{display:flex;justify-content:space-between;gap:8px;padding-bottom:9px;border-bottom:1px solid rgba(90,130,145,.08)}.service-details span{color:#536b76;font:7px Consolas,monospace}.service-details strong{color:#bdd8df;font:9px Consolas,monospace}.service-normal{color:#61f2a1!important}.service-watch{color:#5ee8f3!important}.service-warning{color:#ffc34f!important}.service-critical{color:#ff5b5b!important}.service-icon{color:#8fa6af;font-size:21px}.maintenance-recommendation{min-height:72px;margin-top:16px;padding:14px 17px;display:flex;align-items:center;gap:15px;border-radius:15px;border:1px solid rgba(70,150,165,.16);background:rgba(12,20,27,.7)}.maintenance-recommendation.warning{border-color:rgba(255,190,50,.28)}.maintenance-recommendation.critical{border-color:rgba(255,50,50,.4);background:rgba(80,10,10,.25)}.recommendation-icon{width:37px;height:37px;flex-shrink:0;display:grid;place-items:center;border-radius:10px;color:#61f2a1;background:rgba(45,220,125,.07);font-weight:900}.maintenance-recommendation.warning .recommendation-icon,.maintenance-recommendation.critical .recommendation-icon{color:#ffc34f;background:rgba(255,190,50,.08)}.recommendation-content{flex:1}.recommendation-content span{display:block;margin-bottom:5px;color:#536b76;font:8px Consolas,monospace;letter-spacing:1.2px}.recommendation-content strong{color:#bdd8df;font-size:10px;font-weight:500}.maintenance-ack-button{min-height:35px;padding:0 13px;border-radius:9px;border:1px solid rgba(36,223,241,.22);background:rgba(36,223,241,.045);color:#5ee8f3;font:800 8px Consolas,monospace}.maintenance-checklist{margin-top:16px;padding:19px;border-radius:16px;border:1px solid rgba(70,140,155,.13);background:rgba(8,15,21,.55)}.checklist-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.checklist-subtitle{color:#425963;font:7px Consolas,monospace;letter-spacing:1px}.checklist-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px}.check-item{min-height:60px;padding:11px;display:flex;gap:9px;align-items:flex-start;border-radius:10px;border:1px solid rgba(70,140,155,.09);background:rgba(255,255,255,.015)}.check-status{width:19px;height:19px;flex-shrink:0;display:grid;place-items:center;border-radius:6px;color:#61f2a1;background:rgba(45,220,125,.07);font-size:10px}.check-item strong{display:block;margin-bottom:4px;color:#9ebac2;font:8px Consolas,monospace}.check-item span:last-child{display:block;color:#526b76;font-size:9px;line-height:1.4}@media(max-width:1200px){.maintenance-grid{grid-template-columns:repeat(2,1fr)}.checklist-grid{grid-template-columns:repeat(2,1fr)}}

        .digital-twin-section{margin-top:48px;margin-bottom:48px}.digital-twin-header{margin-bottom:18px}.cell-status{min-width:205px;min-height:42px;padding:0 16px;display:flex;align-items:center;justify-content:center;gap:9px;border-radius:12px;font:800 10px Consolas,monospace;letter-spacing:1px}.cell-status.online{color:#61f2a1;background:rgba(45,220,125,.055);border:1px solid rgba(74,235,148,.24)}.cell-status.standby{color:#5ee8f3;background:rgba(36,223,241,.045);border:1px solid rgba(36,223,241,.22)}.cell-status.stopped{color:#ff5b5b;background:rgba(255,40,40,.07);border:1px solid rgba(255,50,50,.38);animation:cellStopPulse 1.1s infinite alternate}@keyframes cellStopPulse{to{box-shadow:0 0 30px rgba(255,40,40,.16)}}.cell-status-dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor}.digital-twin-shell{display:grid;grid-template-columns:minmax(0,2.15fr) minmax(300px,.85fr);gap:18px;min-height:510px}.digital-twin-viewport{position:relative;overflow:hidden;border-radius:22px;border:1px solid rgba(65,155,175,.2);background:radial-gradient(circle at 48% 38%,rgba(20,87,99,.13),transparent 38%),linear-gradient(145deg,#0b151c,#05090d 72%);box-shadow:0 24px 70px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.035)}.digital-twin-viewport:before{content:"";position:absolute;inset:0;background:linear-gradient(rgba(64,177,190,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(64,177,190,.04) 1px,transparent 1px);background-size:54px 54px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.8),transparent 85%);pointer-events:none}.viewport-topline,.viewport-bottomline{position:absolute;z-index:3;left:22px;right:22px;display:flex;align-items:center;justify-content:space-between;color:#55707a;font:9px Consolas,monospace;letter-spacing:1.5px}.viewport-topline{top:18px}.viewport-bottomline{bottom:15px;justify-content:flex-start;gap:34px}.viewport-bottomline span{color:#6b858e}.robot-cell-svg{position:absolute;inset:42px 18px 35px;width:calc(100% - 36px);height:calc(100% - 77px)}.robot-cell-svg .machine-metal{fill:url(#machineMetal);stroke:#7e9aa2;stroke-width:1.3}.robot-cell-svg .machine-dark{fill:url(#machineDark);stroke:#4c6871;stroke-width:1.2}.robot-cell-svg .machine-edge{fill:none;stroke:#a4b8bc;stroke-opacity:.55;stroke-width:1.4}.robot-cell-svg .machine-glow{fill:#42e0f0;filter:url(#softGlow)}.robot-cell-svg .joint-core{fill:#111c22;stroke:#7ea0a8;stroke-width:2}.robot-cell-svg .joint-ring{fill:none;stroke:#2b7b86;stroke-width:2}.robot-cell-svg .joint-led{fill:#55f19b;filter:url(#softGlow)}.robot-cell-svg .arm-link{fill:url(#armMetal);stroke:#a0aeb0;stroke-width:1.2}.robot-cell-svg .arm-shadow{fill:#11191d;opacity:.9}.robot-cell-svg .mechanical-detail{fill:none;stroke:#405961;stroke-width:2;opacity:.9}.robot-cell-svg .conveyor-frame{fill:#111b20;stroke:#536d75;stroke-width:1.2}.robot-cell-svg .conveyor-belt{fill:#070b0e;stroke:#30454c;stroke-width:1.2}.robot-cell-svg .roller{fill:#26363c;stroke:#607980;stroke-width:1}.robot-cell-svg .product{fill:#a7b0ae;stroke:#667b80;stroke-width:1}.robot-cell-svg .product-line{stroke:#4c666d;stroke-width:2}.robot-cell-svg .scanner{stroke:#3ee7f2;stroke-width:2;filter:url(#softGlow);opacity:.75;animation:scannerSweep 2.6s ease-in-out infinite}.robot-cell-svg .belt-mark{stroke:#41575e;stroke-width:2;stroke-dasharray:8 12;animation:beltMove 1.1s linear infinite}.robot-cell-svg .arm-group{transform-box:fill-box;transform-origin:center;transition:transform .45s cubic-bezier(.22,.7,.25,1)}.robot-cell-svg .joint-group{transform-box:fill-box;transition:transform .45s cubic-bezier(.22,.7,.25,1)}.robot-cell-svg .status-line{stroke:#46dce9;stroke-width:1.4;stroke-dasharray:3 5;opacity:.5}.robot-cell-svg .base-platform{fill:#0d171c;stroke:#4f6971;stroke-width:1.4}.robot-cell-svg .base-top{fill:#1b2a30;stroke:#81979c;stroke-width:1}.robot-cell-svg .warning-led{fill:#ffb74d;filter:url(#softGlow)}.digital-twin-shell .cell-telemetry{padding:24px;border-radius:22px;border:1px solid rgba(65,155,175,.17);background:linear-gradient(145deg,rgba(15,26,34,.95),rgba(6,12,17,.98));box-shadow:0 24px 60px rgba(0,0,0,.25)}.cell-telemetry-title{margin-bottom:22px;color:#5ee8f3;font:800 11px Consolas,monospace;letter-spacing:1.8px}.cell-metric-grid{display:grid;gap:12px}.cell-metric{padding:13px 14px;border-radius:12px;border:1px solid rgba(80,140,155,.11);background:rgba(255,255,255,.015)}.cell-metric>span{display:block;margin-bottom:7px;color:#5c747d;font:9px Consolas,monospace;letter-spacing:1px}.cell-metric strong{display:block;color:#d2e7eb;font:700 21px Consolas,monospace}.cell-metric-bar{height:3px;margin-top:10px;overflow:hidden;border-radius:5px;background:rgba(255,255,255,.06)}.cell-metric-bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#35d9e8,#61f2a1);box-shadow:0 0 10px rgba(53,217,232,.25);transition:width .4s ease}.cell-sensor-stack{display:grid;gap:1px;margin-top:18px;border-top:1px solid rgba(80,140,155,.1);border-bottom:1px solid rgba(80,140,155,.1)}.cell-sensor-stack>div{display:flex;justify-content:space-between;align-items:center;padding:13px 0}.cell-sensor-stack span{color:#536b76;font:9px Consolas,monospace;letter-spacing:1px}.cell-sensor-stack strong{color:#78dfe8;font:700 11px Consolas,monospace}.cell-note{margin-top:18px;padding:13px 14px;border-left:2px solid rgba(36,223,241,.55);background:rgba(36,223,241,.025)}.cell-note span{color:#536b76;font:8px Consolas,monospace;letter-spacing:1.2px}.cell-note p{margin:7px 0 0;color:#748d96;font-size:11px;line-height:1.5}@keyframes scannerSweep{0%,100%{transform:translateY(-38px);opacity:.05}50%{transform:translateY(105px);opacity:.85}}@keyframes beltMove{to{stroke-dashoffset:-20px}}.robot-cell-svg .machine-status{font:800 9px Consolas,monospace;letter-spacing:1.4px;fill:#61f2a1}.robot-cell-svg .machine-caption{font:9px Consolas,monospace;letter-spacing:1px;fill:#607981}.robot-cell-svg .machine-data{font:800 12px Consolas,monospace;fill:#d4e8ec}.robot-cell-svg .arm-beacon{fill:#55f19b;filter:url(#softGlow);animation:beaconPulse 1.5s infinite alternate}@keyframes beaconPulse{to{opacity:.35;transform:scale(1.5)}}@media(max-width:1200px){.digital-twin-shell{grid-template-columns:1fr}.digital-twin-viewport{min-height:460px}}@media(max-width:760px){.digital-twin-viewport{min-height:390px}.viewport-bottomline{gap:12px;font-size:7px}.cell-status{min-width:170px}.digital-twin-shell .cell-telemetry{padding:18px}}

        /* READABILITY BOOST */
        .section-header h2{font-size:26px!important}.hero h1{font-size:42px!important}.eyebrow{font-size:12px!important}.brand-title{font-size:22px!important}.brand-subtitle{font-size:11px!important}.connection-status{font-size:12px!important}.settings-button{font-size:13px!important}.info-strip span{font-size:11px!important}.info-strip strong{font-size:14px!important}.motor-header>div>span{font-size:12px!important}.motor-header h3{font-size:18px!important}.motor-status{font-size:12px!important}.angle-label,.range-labels{font-size:11px!important}.quick-buttons button{font-size:12px!important}.sensor-description{font-size:12px!important}.sensor-limits{font-size:11px!important}.axis-values span{font-size:11px!important}.axis-values strong{font-size:15px!important}.joystick-name{font-size:13px!important}.joystick-data span{font-size:11px!important}.joystick-data strong{font-size:15px!important}.panel-header h3{font-size:18px!important}.panel-header>div>span{font-size:12px!important}.diagnostic-row>span{font-size:13px!important}.diagnostic-row strong{font-size:12px!important}.event-row>span,.event-type{font-size:12px!important}.event-row p{font-size:14px!important}.testing-panel span{font-size:12px!important}.testing-panel p{font-size:13px!important}.testing-buttons button{font-size:12px!important}.emergency-info>div>span{font-size:12px!important}.emergency-info h2{font-size:26px!important}.emergency-info p{font-size:14px!important}.estop-button,.reset-button{font-size:14px!important}.chart-header span{font-size:12px!important}.chart-header strong{font-size:15px!important}.footer{font-size:12px!important}.maintenance-card h3{font-size:16px!important}.maintenance-label{font-size:10px!important}.maintenance-card{font-size:13px}.maintenance-condition,.service-details span{font-size:9px}.service-details strong{font-size:11px}.check-item strong{font-size:10px}.check-item span:last-child{font-size:11px}
      `}</style>

      {overheatAlert && !emergencyStop && (

        <div className="critical-banner">

          <div className="critical-pulse" />

          <strong>⚠ MOTOR 1 OVERHEAT</strong>

          <span>

            BASE TEMPERATURE {temperature.toFixed(1)}°C

          </span>

          <span>IMMEDIATE ATTENTION REQUIRED</span>

        </div>

      )}



      <header className="topbar">

        <div className="brand">

          <div className="factory-logo">SF</div>



          <div>

            <div className="brand-title">

              SMART FACTORY

            </div>



            <div className="brand-subtitle">

              ROBOTIC CONTROL CENTER · SCADA V2.4

            </div>

          </div>

        </div>



        <div className="header-status">

          <div className="connection-status">

            <span className="status-light" />

            COM3 · 115200

          </div>



          <div

            className={`connection-status ${

              espOnline ? "online" : "offline"

            }`}

          >

            <span className="status-light" />

            {espOnline ? "ESP32 ONLINE" : "ESP32 OFFLINE"}

          </div>



          <button
            className="settings-button"
            onClick={connectESP32}
            title={espOnline ? "Disconnect ESP32" : "Connect ESP32"}
            style={{
              width: "auto",
              minWidth: "125px",
              padding: "0 14px",
              color: espOnline ? "#55f19b" : "#24dff1",
              borderColor: espOnline ? "rgba(85, 241, 155, 0.4)" : "rgba(36, 223, 241, 0.35)",
            }}
          >
            {espOnline ? "● DISCONNECT" : "↯ CONNECT ESP32"}
          </button>

        </div>

      </header>



      <main className="dashboard">

        <section className="hero">

          <div>

            <div className="eyebrow">

              INDUSTRIAL AUTOMATION SYSTEM

            </div>



            <h1>Robotic Arm Command Center</h1>



            <p>

              Real-time robotic control and Motor 1 condition

              monitoring

            </p>

          </div>



          <div

            className={`system-indicator ${temperatureStatus.level}`}

          >

            <span className="indicator-dot" />



            {emergencyStop

              ? "EMERGENCY STOP"

              : temperatureStatus.label === "NORMAL"

              ? "SYSTEM NOMINAL"

              : `SYSTEM ${temperatureStatus.label}`}

          </div>

        </section>



        <section className="info-strip">

          <div>

            <span>CONTROLLER</span>

            <strong>ESP32 · 3.3V · 50Hz</strong>

          </div>



          <div>

            <span>SERVOS</span>

            <strong>4 / 4 ONLINE</strong>

          </div>



          <div>

            <span>SENSORS</span>

            <strong>DS18B20 + MPU6050</strong>

          </div>



          <div>

            <span>PORT</span>

            <strong>COM3</strong>

          </div>

        </section>



        <div className="section-header">

          <div>

            <span className="section-number">

              01 · ROBOT CONTROL

            </span>

            <h2>Servo Motor Control</h2>

          </div>



          <div className="robot-control-actions">

            <div className="control-authority">

              <span className="control-authority-label">CONTROL AUTHORITY</span>

              <div className="control-mode-switch" role="group" aria-label="Control authority">

                <button
                  type="button"
                  className={controlMode === "DASHBOARD" ? "active" : ""}
                  disabled={emergencyStop || recovery}
                  onClick={() => changeControlMode("DASHBOARD")}
                >
                  ● DASHBOARD CONTROL
                </button>

                <button
                  type="button"
                  className={controlMode === "JOYSTICK" ? "active joystick-active" : ""}
                  disabled={emergencyStop || recovery}
                  onClick={() => changeControlMode("JOYSTICK")}
                >
                  🎮 JOYSTICK CONTROL
                </button>

              </div>

            </div>

            <button

              className="home-button"

              disabled={emergencyStop || recovery || controlMode !== "DASHBOARD"}

              onClick={goHome}

            >

              ⌂ HOME POSITION

            </button>

          </div>

        </div>



        <section className="motor-grid">

          {motors.map((motor) => (

            <div

              className={`motor-card ${

                emergencyStop || recovery ? "locked-card" : ""

              }`}

              key={motor.id}

            >

              <div className="motor-header">

                <div>

                  <span>MOTOR 0{motor.id}</span>

                  <h3>{motor.name}</h3>

                </div>



                <div

                  className={

                    emergencyStop || recovery

                      ? "motor-status locked"

                      : "motor-status"

                  }

                >

                  ●{" "}

                  {emergencyStop || recovery

                    ? "LOCKED"

                    : "READY"}

                </div>

              </div>



              <div className="angle">

                {motor.angle}

                <small>°</small>

              </div>



              <div className="angle-label">

                CURRENT POSITION

              </div>



              <input

                type="range"

                min="0"

                max="180"

                value={motor.angle}

                disabled={emergencyStop || recovery || controlMode !== "DASHBOARD"}

                onChange={(e) =>

                  updateMotor(motor.id, e.target.value)

                }

              />



              <div className="range-labels">

                <span>0°</span>

                <span>90°</span>

                <span>180°</span>

              </div>



              <div className="quick-buttons">

                {[0, 90, 180].map((value) => (

                  <button

                    key={value}

                    disabled={emergencyStop || recovery || controlMode !== "DASHBOARD"}

                    onClick={() =>

                      updateMotor(motor.id, value)

                    }

                  >

                    {value}°

                  </button>

                ))}

              </div>

            </div>

          ))}

        </section>

        <div className={`control-mode-status ${controlMode === "DASHBOARD" ? "dashboard-mode" : "joystick-mode"}`}>
          <span className="control-mode-dot" />
          <strong>{controlMode === "DASHBOARD" ? "DASHBOARD CONTROL ACTIVE" : "JOYSTICK CONTROL ACTIVE"}</strong>
          <span>·</span>
          <span>{controlMode === "DASHBOARD" ? "Panel commands have authority" : "Physical joystick input has authority"}</span>
        </div>



        <section className="sensor-section">

          <div

            className={`sensor-card temperature-card ${temperatureStatus.level}`}

          >

            <div className="sensor-top">

              <div className="sensor-icon temperature-icon">

                °C

              </div>



              <span className="sensor-status">

                {temperatureStatus.label}

              </span>

            </div>



            <span className="sensor-heading">

              MOTOR 1 / BASE TEMPERATURE

            </span>



            <div className="sensor-number">

              {temperature.toFixed(1)}

              <small>°C</small>

            </div>



            <div className="sensor-description">

              DS18B20 · SENSOR ATTACHED

            </div>



            <div className="temperature-scale">

              <div

                className="temperature-fill"

                style={{

                  width: `${Math.min(

                    100,

                    (temperature / 100) * 100

                  )}%`,

                }}

              />

            </div>



            <div className="sensor-limits">

              <span>NORMAL &lt; 45°C</span>

              <span>CRITICAL ≥ 70°C</span>

              <span>OVERHEAT ≥ 80°C</span>

            </div>

          </div>



          <div className="sensor-card vibration-card">

            <div className="sensor-top">

              <div className="sensor-icon vibration-icon">

                ∿

              </div>



              <span className="sensor-status normal">

                NORMAL

              </span>

            </div>



            <span className="sensor-heading">

              MOTOR 1 / BASE VIBRATION

            </span>



            <div className="sensor-number">

              {vibration.toFixed(2)}

              <small> g</small>

            </div>



            <div className="sensor-description">

              MPU6050 · AX / AY / AZ

            </div>



            <div className="axis-values">

              <div>

                <span>AX</span>

                <strong>{axes.ax.toFixed(2)}</strong>

              </div>



              <div>

                <span>AY</span>

                <strong>{axes.ay.toFixed(2)}</strong>

              </div>



              <div>

                <span>AZ</span>

                <strong>{axes.az.toFixed(2)}</strong>

              </div>

            </div>

          </div>

        </section>



        <section className="control-grid">

          <div className="panel">

            <PanelHeader

              number="02"

              title="DUAL JOYSTICK CONTROL"

              subtitle="REAL-TIME ADC INPUT"

            />



            <div className="joystick-grid">

              <Joystick

                name="JOYSTICK 1"

                x={joysticks.j1x}

                y={joysticks.j1y}

                axisX="BASE"

                axisY="SHOULDER"

                interactive={controlMode === "JOYSTICK" && !emergencyStop && !recovery}

                onMove={moveVirtualJoystick}

              />



              <Joystick

                name="JOYSTICK 2"

                x={joysticks.j2x}

                y={joysticks.j2y}

                axisX="ELBOW"

                axisY="GRIPPER"

                interactive={controlMode === "JOYSTICK" && !emergencyStop && !recovery}

                onMove={moveVirtualJoystick}

              />

            </div>

          </div>



          <div className="panel gripper-panel">

            <PanelHeader

              number="03"

              title="GRIPPER CONTROL"

              subtitle="END EFFECTOR"

            />



            <div className="gripper-display">

              <div

                className={`gripper-symbol ${

                  gripper === "OPEN" ? "gripper-open" : ""

                }`}

              >

                {gripper === "OPEN" ? "⟨  ⟩" : "⟪  ⟫"}

              </div>



              <span>GRIPPER STATE</span>



              <strong>{gripper}</strong>

            </div>



            <div className="gripper-buttons">

              <button

                disabled={emergencyStop || recovery}

                onClick={openGripper}

              >

                OPEN

              </button>



              <button

                disabled={emergencyStop || recovery}

                onClick={closeGripper}

              >

                CLOSE

              </button>

            </div>

          </div>

        </section>



        <section className="panel graph-panel">

          <PanelHeader

            number="04"

            title="LIVE CONDITION MONITOR"

            subtitle="MOTOR 1 / BASE"

          />



          <div className="graphs">

            <SimpleGraph

              title="TEMPERATURE"

              value={`${temperature.toFixed(1)}°C`}

              data={history.map((x) => x.temperature)}

              type="temperature"

            />



            <SimpleGraph

              title="VIBRATION"

              value={`${vibration.toFixed(2)} g`}

              data={history.map((x) => x.vibration)}

              type="vibration"

            />

          </div>

        </section>



        {/* =====================================================
            05 · LIVE ROBOTIC CELL / DIGITAL TWIN
            ===================================================== */}
        <section className="digital-twin-section">
          <div className="section-header digital-twin-header">
            <div>
              <span className="section-number">05 · LIVE ROBOTIC CELL</span>
              <h2>Industrial Digital Twin</h2>
            </div>
            <div className={`cell-status ${emergencyStop ? "stopped" : espOnline ? "online" : "standby"}`}>
              <span className="cell-status-dot" />
              {emergencyStop ? "MACHINE STOPPED" : espOnline ? "CELL ONLINE" : "SIMULATION / STANDBY"}
            </div>
          </div>

          <div className="digital-twin-shell">
            <div className="digital-twin-viewport">
              <div className="viewport-topline">
                <span>ROBOTIC WORKCELL · MODEL REFERENCE</span>
                <span>3-AXIS + GRIPPER POSITION FEEDBACK</span>
              </div>

              <RobotCell motors={motors} emergencyStop={emergencyStop} />

              <div className="viewport-bottomline">
                <span>BASE</span><span>SHOULDER</span><span>ELBOW</span><span>GRIPPER</span>
              </div>
            </div>

            <div className="cell-telemetry">
              <div className="cell-telemetry-title">LIVE CELL TELEMETRY</div>
              <div className="cell-metric-grid">
                {motors.map((motor) => (
                  <div className="cell-metric" key={motor.id}>
                    <span>M{motor.id} · {motor.name}</span>
                    <strong>{motor.id === 4 ? (motor.angle >= 90 ? "OPEN" : "CLOSED") : `${Math.round(motor.angle)}°`}</strong>
                    <div className="cell-metric-bar"><i style={{ width: `${motor.id === 4 ? motor.angle : motor.angle}%` }} /></div>
                  </div>
                ))}
              </div>

              <div className="cell-sensor-stack">
                <div><span>TEMPERATURE</span><strong>{temperature.toFixed(1)} °C</strong></div>
                <div><span>VIBRATION</span><strong>{vibration.toFixed(2)} g</strong></div>
                <div><span>CONTROLLER</span><strong>{espOnline ? "ESP32 ONLINE" : "OFFLINE"}</strong></div>
              </div>

              <div className="cell-note">
                <span>MODEL BASIS</span>
                <p>Digital representation follows the physical arm geometry: 3 articulated joints plus a dedicated gripper servo.</p>
              </div>
            </div>
          </div>
        </section>



        {/* =====================================================
            09 · PREDICTIVE MAINTENANCE
            ===================================================== */}
        <section className="maintenance-section">
          <div className="section-header maintenance-header">
            <div>
              <span className="section-number">09 · PREDICTIVE MAINTENANCE</span>
              <h2>Asset Health & Maintenance</h2>
            </div>

            <div className={`maintenance-status ${maintenanceStatus.level}`}>
              <span className="maintenance-status-dot" />
              {maintenanceStatus.label}
            </div>
          </div>

          <div className="maintenance-grid">
            <div className="maintenance-card health-card">
              <div className="maintenance-card-header">
                <div>
                  <span className="maintenance-label">ASSET HEALTH</span>
                  <h3>MOTOR 1 / BASE</h3>
                </div>
                <div className={`health-indicator ${maintenanceStatus.level}`}>●</div>
              </div>

              <div className="health-score">
                <div className="health-score-value">{maintenanceHealthIndex}</div>
                <span>HEALTH INDEX</span>
              </div>

              <div className="health-message">{maintenanceStatus.message}</div>
            </div>

            <div className="maintenance-card">
              <div className="maintenance-card-header">
                <div>
                  <span className="maintenance-label">THERMAL CONDITION</span>
                  <h3>DS18B20 · MOTOR 1 / BASE</h3>
                </div>
                <span className="maintenance-icon temperature-icon">°C</span>
              </div>

              <div className="maintenance-metric">{temperature.toFixed(1)}<small>°C</small></div>

              <div className="maintenance-range">
                <div className="maintenance-range-fill temperature-fill" style={{ width: `${Math.min(100, (temperature / 80) * 100)}%` }} />
              </div>

              <div className="maintenance-range-labels">
                <span>NORMAL</span><span>45°C</span><span>60°C</span><span>80°C</span>
              </div>

              <div className="maintenance-condition">
                STATUS: <strong>{temperatureStatus.label}</strong>
              </div>
            </div>

            <div className="maintenance-card">
              <div className="maintenance-card-header">
                <div>
                  <span className="maintenance-label">VIBRATION CONDITION</span>
                  <h3>MPU6050 · MOTOR 1 / BASE</h3>
                </div>
                <span className="maintenance-icon vibration-icon">VIB</span>
              </div>

              <div className="maintenance-metric">{vibration.toFixed(2)}<small> g</small></div>

              <div className="maintenance-range">
                <div className="maintenance-range-fill vibration-fill" style={{ width: `${Math.min(100, (vibration / 0.65) * 100)}%` }} />
              </div>

              <div className="maintenance-range-labels">
                <span>NORMAL</span><span>0.25g</span><span>0.40g</span><span>0.65g</span>
              </div>

              <div className="maintenance-condition">
                STATUS: <strong>{vibration < 0.25 ? "NORMAL" : vibration < 0.40 ? "MONITOR" : vibration < 0.65 ? "INSPECT" : "CRITICAL"}</strong>
              </div>
            </div>

            <div className="maintenance-card">
              <div className="maintenance-card-header">
                <div>
                  <span className="maintenance-label">SERVICE STATUS</span>
                  <h3>MAINTENANCE</h3>
                </div>
                <span className="service-icon">⚙</span>
              </div>

              <div className="service-details">
                <div><span>LAST SERVICE</span><strong>{lastServiceDate}</strong></div>
                <div><span>RUNTIME</span><strong>{runtimeHours}h {runtimeMinutes}m</strong></div>
                <div><span>MOVEMENT CYCLES</span><strong>{movementCycles.toLocaleString()}</strong></div>
                <div><span>SERVICE STATE</span><strong className={`service-${maintenanceStatus.level}`}>{maintenanceStatus.label}</strong></div>
              </div>
            </div>
          </div>

          <div className={`maintenance-recommendation ${maintenanceStatus.level}`}>
            <div className="recommendation-icon">{maintenanceStatus.level === "normal" ? "✓" : "!"}</div>
            <div className="recommendation-content">
              <span>MAINTENANCE RECOMMENDATION</span>
              <strong>
                {maintenanceStatus.level === "normal" && "Continue normal operation and routine inspection."}
                {maintenanceStatus.level === "watch" && "Monitor Motor 1 temperature and vibration during operation."}
                {maintenanceStatus.level === "warning" && "Schedule an inspection of Motor 1 / Base, mounting and mechanical components."}
                {maintenanceStatus.level === "critical" && "Stop operation and inspect Motor 1 / Base before further operation."}
              </strong>
            </div>
            <button className="maintenance-ack-button" onClick={() => {
              setMaintenanceAcknowledged(true);
              addEvent("MAINTENANCE", "Maintenance condition acknowledged by operator");
            }}>
              {maintenanceAcknowledged ? "ACKNOWLEDGED" : "ACKNOWLEDGE"}
            </button>
          </div>

          <div className="maintenance-checklist">
            <div className="checklist-title">
              <span className="section-number">MAINTENANCE CHECKLIST</span>
              <span className="checklist-subtitle">CONDITION-BASED INSPECTION</span>
            </div>
            <div className="checklist-grid">
              <div className="check-item"><span className="check-status">✓</span><div><strong>MOTOR 1 / BASE</strong><span>Check mounting and mechanical looseness</span></div></div>
              <div className="check-item"><span className="check-status">✓</span><div><strong>DS18B20</strong><span>Monitor abnormal temperature rise</span></div></div>
              <div className="check-item"><span className="check-status">✓</span><div><strong>MPU6050</strong><span>Monitor abnormal vibration pattern</span></div></div>
              <div className="check-item"><span className="check-status">✓</span><div><strong>SERVO SYSTEM</strong><span>Check unusual noise, movement and load</span></div></div>
            </div>
          </div>
        </section>

        <section className="lower-grid">

          <div className="panel">

            <PanelHeader

              number="06"

              title="SAFETY MONITOR"

              subtitle="SYSTEM PROTECTION"

            />



            <div

              className={`safety-box ${

                temperatureStatus.level

              }`}

            >

              <div className="safety-symbol">

                {emergencyStop ? "■" : "✓"}

              </div>



              <div>

                <strong>

                  {emergencyStop

                    ? "SYSTEM LOCKED"

                    : temperatureStatus.label}

                </strong>



                <span>

                  {emergencyStop

                    ? "Operator reset required"

                    : temperatureStatus.message}

                </span>

              </div>

            </div>



            {overheatAlert && !emergencyStop && (

              <button

                className="recovery-button"

                onClick={startSafeRecovery}

                disabled={recovery}

              >

                ⚡ START CONTROLLED SAFE RECOVERY

              </button>

            )}



            {recovery && (

              <div className="recovery-progress">

                <div className="recovery-spinner" />

                <strong>{recoveryStep}</strong>

              </div>

            )}

          </div>



          <div className="panel">

            <PanelHeader

              number="07"

              title="DIAGNOSTICS"

              subtitle="HARDWARE STATUS"

            />



            <Diagnostic name="ESP32 CONTROLLER" />

            <Diagnostic name="SERVO 1 · BASE" />

            <Diagnostic name="SERVO 2 · SHOULDER" />

            <Diagnostic name="SERVO 3 · ELBOW" />

            <Diagnostic name="SERVO 4 · GRIPPER" />

            <Diagnostic name="DS18B20" />

            <Diagnostic name="MPU6050" />

          </div>

        </section>



        <section className="panel event-panel">

          <PanelHeader

            number="08"

            title="EVENT LOG"

            subtitle="SCADA AUDIT TRAIL"

          />



          <div className="event-list">

            {events.map((event, index) => (

              <div className="event-row" key={index}>

                <span>{event.time}</span>



                <strong

                  className={`event-type ${event.type.toLowerCase()}`}

                >

                  {event.type}

                </strong>



                <p>{event.message}</p>

              </div>

            ))}

          </div>

        </section>



        <section className="testing-panel">

          <div>

            <span>DEVELOPMENT / TEST MODE</span>

            <p>

              Temporary controls for testing dashboard safety

              states before ESP32 integration.

            </p>

          </div>



          <div className="testing-buttons">

            <button onClick={simulateOverheat}>

              TEST OVERHEAT

            </button>



            <button onClick={clearTestTemperature}>

              CLEAR TEMPERATURE

            </button>

          </div>

        </section>



        <section

          className={`emergency-panel ${

            emergencyStop ? "emergency-active" : ""

          }`}

        >

          <div className="emergency-info">

            <div className="emergency-symbol">

              !

            </div>



            <div>

              <span>EMERGENCY SAFETY SYSTEM</span>



              <h2>

                {emergencyStop

                  ? "EMERGENCY STOP ACTIVE"

                  : "EMERGENCY STOP"}

              </h2>



              <p>

                {emergencyStop

                  ? "All robotic commands are locked. Verify machine condition before reset."

                  : "Immediately lock robotic commands and place the system in a safe state."}

              </p>

            </div>

          </div>



          {!emergencyStop ? (

            <button

              className="estop-button"

              onClick={triggerEmergencyStop}

            >

              ! EMERGENCY STOP

            </button>

          ) : (

            <button

              className="reset-button"

              onClick={resetSystem}

            >

              ↻ RESET SYSTEM

            </button>

          )}

        </section>

      </main>



      <footer className="footer">

        <span>SMART FACTORY · SCADA V2.4</span>

        <span>ESP32 ● {espOnline ? "ONLINE" : "OFFLINE"}</span>

        <span>SERVOS 4/4 ACTIVE</span>

        <span>TEMP {temperatureStatus.label}</span>

        <span>

          {emergencyStop

            ? "E-STOP ACTIVE"

            : "E-STOP CLEARED"}

        </span>

      </footer>

    </div>

  );

}



function PanelHeader({ number, title, subtitle }) {

  return (

    <div className="panel-header">

      <span className="panel-number">{number}</span>



      <div>

        <h3>{title}</h3>

        <span>{subtitle}</span>

      </div>

    </div>

  );

}



function Joystick({
  name,
  x,
  y,
  axisX,
  axisY,
  interactive = false,
  onMove,
}) {
  const circleRef = useRef(null);
  const draggingRef = useRef(false);

  const knobX = ((x - 2048) / 2048) * 42;
  const knobY = ((y - 2048) / 2048) * 42;

  const updateFromPointer = (clientX, clientY) => {
    if (!interactive || !circleRef.current || !onMove) return;

    const rect = circleRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radius = Math.min(rect.width, rect.height) * 0.38;

    let nx = (clientX - centerX) / radius;
    let ny = (clientY - centerY) / radius;

    nx = Math.max(-1, Math.min(1, nx));
    ny = Math.max(-1, Math.min(1, ny));

    const nextX = Math.round(2048 + nx * 2047);
    const nextY = Math.round(2048 + ny * 2047);

    onMove(name, nextX, nextY);
  };

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (!draggingRef.current) return;
      updateFromPointer(event.clientX, event.clientY);
    };

    const handlePointerUp = () => {
      draggingRef.current = false;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  });

  const handlePointerDown = (event) => {
    if (!interactive) return;
    draggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateFromPointer(event.clientX, event.clientY);
  };

  const handleDoubleClick = () => {
    if (!interactive || !onMove) return;
    onMove(name, 2048, 2048);
  };

  return (
    <div className={`joystick ${interactive ? "joystick-interactive" : ""}`}>
      <div className="joystick-name">{name}</div>

      <div
        ref={circleRef}
        className="joystick-circle"
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        title={interactive ? "Drag joystick to control motors" : "Telemetry display"}
      >
        <div className="joystick-cross horizontal" />
        <div className="joystick-cross vertical" />

        <div
          className="joystick-knob"
          style={{
            transform: `translate(${knobX}px, ${knobY}px)`,
          }}
        />

        {interactive && <span className="joystick-live-label">DRAG</span>}
      </div>

      <div className="joystick-data">
        <div>
          <span>X / {axisX}</span>
          <strong>{Math.round(x)}</strong>
        </div>

        <div>
          <span>Y / {axisY}</span>
          <strong>{Math.round(y)}</strong>
        </div>
      </div>

      <div className="joystick-control-hint">
        {interactive ? "VIRTUAL INPUT ACTIVE · DRAG TO CONTROL" : "TELEMETRY DISPLAY"}
      </div>
    </div>
  );
}

function RobotCell({ motors, emergencyStop }) {
  const base = Math.max(-78, Math.min(78, (motors?.[0]?.angle ?? 90) - 90));
  const shoulder = Math.max(-62, Math.min(62, (motors?.[1]?.angle ?? 75) - 90));
  const elbow = Math.max(-78, Math.min(78, (motors?.[2]?.angle ?? 70) - 90));

  // S4 is the dedicated gripper servo on the real model.
  // 0° = closed, 180° = open. The arm wrist housing itself stays fixed.
  const gripperAngle = Math.max(0, Math.min(180, motors?.[3]?.angle ?? 90));
  const gripperOpen = gripperAngle >= 90;
  const jawGap = 7 + (gripperAngle / 180) * 18;

  return (
    <svg className="robot-cell-svg" viewBox="0 0 900 500" role="img" aria-label="Live industrial robotic arm digital twin with gripper">
      <defs>
        <linearGradient id="machineMetal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#59676b" />
          <stop offset="0.28" stopColor="#202c31" />
          <stop offset="0.62" stopColor="#111a1e" />
          <stop offset="1" stopColor="#46555a" />
        </linearGradient>
        <linearGradient id="machineDark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#26343a" />
          <stop offset="1" stopColor="#080d10" />
        </linearGradient>
        <linearGradient id="armMetal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#9a9b94" />
          <stop offset="0.18" stopColor="#d0c5aa" />
          <stop offset="0.55" stopColor="#806f58" />
          <stop offset="1" stopColor="#c7b998" />
        </linearGradient>
        <filter id="softGlow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <pattern id="floorPattern" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M0 28L28 0" stroke="#31454b" strokeOpacity=".22" strokeWidth="1" />
        </pattern>
      </defs>

      <ellipse cx="420" cy="405" rx="280" ry="35" fill="#000" opacity=".38" />
      <rect x="45" y="350" width="810" height="90" rx="12" fill="url(#floorPattern)" opacity=".7" />
      <line x1="45" y1="350" x2="855" y2="350" stroke="#35525b" strokeWidth="1" />

      {/* Industrial conveyor */}
      <g transform="translate(555 275)">
        <rect className="conveyor-frame" x="0" y="35" width="285" height="95" rx="9" />
        <rect className="conveyor-belt" x="14" y="48" width="257" height="58" rx="5" />
        {[35,82,129,176,223,256].map((x) => <circle key={x} className="roller" cx={x} cy="77" r="13" />)}
        <path className="belt-mark" d="M25 77 H260" />
        <rect className="product" x="72" y="32" width="48" height="35" rx="3" />
        <path className="product-line" d="M80 41H112M80 49H104" />
        <rect className="product" x="170" y="32" width="48" height="35" rx="3" />
        <path className="product-line" d="M178 41H210M178 49H202" />
        <text className="machine-caption" x="14" y="145">MATERIAL TRANSFER / CONVEYOR</text>
        <line className="scanner" x1="145" y1="5" x2="145" y2="120" />
      </g>

      {/* Fixed base */}
      <g>
        <rect className="base-platform" x="120" y="316" width="290" height="42" rx="10" />
        <rect className="base-top" x="150" y="295" width="230" height="43" rx="9" />
        <circle cx="265" cy="314" r="48" className="joint-ring" />
        <circle cx="265" cy="314" r="32" className="joint-core" />
        <circle cx="265" cy="314" r="6" className={emergencyStop ? "warning-led" : "joint-led"} />
        <text className="machine-caption" x="154" y="385">M1 / BASE DRIVE</text>
        <text className="machine-status" x="325" y="385">{emergencyStop ? "LOCKED" : "ACTIVE"}</text>
      </g>

      {/* 3 articulated joints: Base + Shoulder + Elbow */}
      <g transform={`rotate(${base} 265 295)`}>
        <g transform={`rotate(${shoulder} 265 295)`}>
          <rect className="arm-shadow" x="245" y="181" width="40" height="116" rx="7" />
          <rect className="arm-link" x="249" y="178" width="32" height="119" rx="6" />
          <path className="mechanical-detail" d="M257 190V284M273 190V284" />
          <circle cx="265" cy="180" r="23" className="joint-core" />
          <circle cx="265" cy="180" r="15" className="joint-ring" />
          <circle cx="265" cy="180" r="5" className="joint-led" />

          <g transform={`rotate(${elbow} 265 180)`}>
            <rect className="arm-shadow" x="264" y="167" width="126" height="27" rx="5" />
            <rect className="arm-link" x="264" y="163" width="128" height="29" rx="5" />
            <path className="mechanical-detail" d="M278 169H378M278 185H378" />
            <circle cx="392" cy="178" r="22" className="joint-core" />
            <circle cx="392" cy="178" r="14" className="joint-ring" />
            <circle cx="392" cy="178" r="5" className="joint-led" />

            {/* Fixed wrist housing + dedicated gripper servo */}
            <g>
              <rect className="arm-shadow" x="391" y="169" width="102" height="19" rx="4" />
              <rect className="arm-link" x="392" y="166" width="103" height="22" rx="4" />
              <path className="mechanical-detail" d="M405 171H480M405 183H480" />
              <circle cx="498" cy="177" r="16" className="joint-core" />
              <circle cx="498" cy="177" r="10" className="joint-ring" />
              <circle cx="498" cy="177" r="4" className={gripperOpen ? "joint-led" : "warning-led"} />

              {/* S4 gripper jaws — opening/closing only */}
              <g transform="translate(505 177)">
                <rect className="machine-metal" x="0" y="-11" width="45" height="22" rx="4" />
                <path
                  className="machine-edge"
                  d={`M43 -7 L64 ${-jawGap} L69 ${-jawGap + 4} L52 0`}
                />
                <path
                  className="machine-edge"
                  d={`M43 7 L64 ${jawGap} L69 ${jawGap - 4} L52 0`}
                />
                <circle cx="8" cy="0" r="3" className="joint-led" />
              </g>
            </g>
          </g>
        </g>
      </g>

      
      
      <text className="machine-data" x="92" y="105">3-AXIS ROBOTIC ARM + GRIPPER</text>
      <text className="machine-caption" x="92" y="124">LIVE POSITION / END-EFFECTOR FEEDBACK</text>
      <text className="machine-data" x="92" y="155">
        {Math.round(motors?.[0]?.angle ?? 90)}° / {Math.round(motors?.[1]?.angle ?? 75)}° / {Math.round(motors?.[2]?.angle ?? 70)}° / {gripperOpen ? "OPEN" : "CLOSED"}
      </text>
      <text className="machine-status" x="705" y="105">GRIPPER {gripperOpen ? "OPEN" : "CLOSED"}</text>
    </svg>
  );
}

function Diagnostic({ name }) {

  return (

    <div className="diagnostic-row">

      <span>{name}</span>



      <strong>

        <i />

        ONLINE

      </strong>

    </div>

  );

}



function SimpleGraph({

  title,

  value,

  data,

  type,

}) {

  const width = 600;

  const height = 180;



  const max = Math.max(...data);

  const min = Math.min(...data);

  const range = max - min || 1;



  const points = data

    .map((value, index) => {

      const x =

        (index / (data.length - 1)) *

        width;



      const y =

        height -

        ((value - min) / range) *

          (height - 25);



      return `${x},${y}`;

    })

    .join(" ");



  return (

    <div className="chart">

      <div className="chart-header">

        <span>{title}</span>

        <strong>{value}</strong>

      </div>



      <svg

        viewBox={`0 0 ${width} ${height}`}

        preserveAspectRatio="none"

      >

        <line

          x1="0"

          y1="45"

          x2={width}

          y2="45"

          className="graph-grid"

        />



        <line

          x1="0"

          y1="90"

          x2={width}

          y2="90"

          className="graph-grid"

        />



        <line

          x1="0"

          y1="135"

          x2={width}

          y2="135"

          className="graph-grid"

        />



        <polyline

          points={points}

          fill="none"

          className={

            type === "temperature"

              ? "temperature-line"

              : "vibration-line"

          }

        />

      </svg>

    </div>

  );

}



export default App;