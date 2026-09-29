import { useEffect, useMemo, useRef, useState } from "react";



import "./App.css";







const DEFAULT_MOTORS = [



  { id: 1, name: "BASE", angle: 90 },



  { id: 2, name: "SHOULDER", angle: 75 },



  { id: 3, name: "ELBOW", angle: 70 },



  { id: 4, name: "WRIST", angle: 77 },



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
  const [hardwareEstop, setHardwareEstop] = useState(false);
  const [lastCommand, setLastCommand] = useState("—");
  const [commandBusy, setCommandBusy] = useState(false);

  const serialPortRef = useRef(null);

  const serialReaderRef = useRef(null);
  const serialWriteChainRef = useRef(Promise.resolve());







  const [recovery, setRecovery] = useState(false);



  const [recoveryStep, setRecoveryStep] = useState("");







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
    if (clean === "ACK:MODE:DASHBOARD") { setControlMode("DASHBOARD"); setCommandBusy(false); addEvent("CONTROL", "ESP32 acknowledged DASHBOARD CONTROL"); return; }
    if (clean === "ACK:MODE:JOYSTICK") { setControlMode("JOYSTICK"); setCommandBusy(false); addEvent("CONTROL", "ESP32 acknowledged JOYSTICK CONTROL"); return; }
    if (clean === "ACK:ESTOP:1") { setHardwareEstop(true); setCommandBusy(false); addEvent("E-STOP", "ESP32 command lock acknowledged"); return; }
    if (clean === "ACK:ESTOP:0") { setHardwareEstop(false); setCommandBusy(false); addEvent("SYSTEM", "ESP32 E-STOP lock cleared"); return; }
    if (clean.startsWith("ACK:SET:")) { setCommandBusy(false); return; }
    if (clean === "ESTOP:LOCKED") { setHardwareEstop(true); setEmergencyStop(true); setCommandBusy(false); addEvent("E-STOP", "ESP32 rejected movement because E-STOP is locked"); return; }
    if (clean.startsWith("MODE:")) { setControlMode(clean.endsWith("JOYSTICK") ? "JOYSTICK" : "DASHBOARD"); return; }
    if (clean.startsWith("ESTOP:")) { setHardwareEstop(clean.endsWith("LOCKED")); return; }
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
      case "J1X": case "J1Y": case "J2X": case "J2Y": setJoysticks((old) => ({ ...old, [key.toLowerCase()]: value })); break;
      case "S1": case "S2": case "S3": case "S4": { const id = Number(key.substring(1)); setMotors((old) => old.map((motor) => motor.id === id ? { ...motor, angle: Math.max(0, Math.min(180, Math.round(value))) } : motor)); break; }
      default: break;
    }
  };

  const queueSerialCommand = (command) => {
    const port = serialPortRef.current;
    if (!port?.writable || !espOnline) { addEvent("WARNING", `Command blocked — ESP32 offline: ${command}`); return false; }
    setLastCommand(command); setCommandBusy(true);
    serialWriteChainRef.current = serialWriteChainRef.current.then(async () => { const writer = port.writable.getWriter(); try { await writer.write(new TextEncoder().encode(`${command}\n`)); addEvent("COMMAND", `TX → ${command}`); } finally { writer.releaseLock(); } }).catch((error) => { setCommandBusy(false); addEvent("ERROR", `Serial command failed: ${error.message}`); });
    return true;
  };

  const setControl = (mode) => {
    if (!espOnline || emergencyStop || recovery || hardwareEstop || mode === controlMode) return;
    if (queueSerialCommand(`MODE:${mode}`)) { setControlMode(mode); addEvent("CONTROL", `${mode} CONTROL selected`); }
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







  const updateMotor = (id, value) => {



    if (emergencyStop || recovery) return;







    const angle = Math.max(0, Math.min(180, Number(value)));







    setMotors((old) =>



      old.map((motor) =>



        motor.id === id ? { ...motor, angle } : motor



      )



    );







    addEvent("SERVO", `Motor ${id} moved to ${angle}°`);



  };







  const goHome = () => {



    if (emergencyStop || recovery) return;







    setMotors([



      { id: 1, name: "BASE", angle: 90 },



      { id: 2, name: "SHOULDER", angle: 90 },



      { id: 3, name: "ELBOW", angle: 90 },



      { id: 4, name: "WRIST", angle: 90 },



    ]);







    addEvent("ARM", "Arm commanded to HOME position");



  };







  const openGripper = () => {



    if (emergencyStop || recovery) return;







    setGripper("OPEN");



    addEvent("GRIPPER", "Gripper OPEN command");



  };







  const closeGripper = () => {



    if (emergencyStop || recovery) return;







    setGripper("CLOSED");



    addEvent("GRIPPER", "Gripper CLOSE command");



  };







  const triggerEmergencyStop = () => {



    setEmergencyStop(true);



    setRecovery(false);



    setRecoveryStep("");







    addEvent(



      "E-STOP",



      "Emergency stop activated — all commands locked"



    );



  };







  const resetSystem = () => {



    setEmergencyStop(false);



    setRecovery(false);



    setRecoveryStep("");







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



        { id: 4, name: "WRIST", angle: 90 },



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







          <button



            className="home-button"



            disabled={emergencyStop || recovery || hardwareEstop || (espOnline && controlMode !== "DASHBOARD")}



            onClick={goHome}



          >



            ⌂ HOME POSITION



          </button>



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



                disabled={emergencyStop || recovery || hardwareEstop || (espOnline && controlMode !== "DASHBOARD")}



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



                    disabled={emergencyStop || recovery || hardwareEstop || (espOnline && controlMode !== "DASHBOARD")}



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



              />







              <Joystick



                name="JOYSTICK 2"



                x={joysticks.j2x}



                y={joysticks.j2y}



                axisX="ELBOW"



                axisY="WRIST"



              />



            </div>



          </div>







          <div className="panel gripper-panel">



            <PanelHeader



              number="03"



              title="GRIPPER CONTROL"



              subtitle="END EFFECTOR · UI ONLY"



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



                disabled={emergencyStop || recovery || hardwareEstop || (espOnline && controlMode !== "DASHBOARD")}



                onClick={openGripper}



              >



                OPEN



              </button>







              <button



                disabled={emergencyStop || recovery || hardwareEstop || (espOnline && controlMode !== "DASHBOARD")}



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







        <section className="lower-grid">



          <div className="panel">



            <PanelHeader



              number="05"



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



              number="06"



              title="DIAGNOSTICS"



              subtitle="HARDWARE STATUS"



            />







            <Diagnostic name="ESP32 CONTROLLER" />



            <Diagnostic name="SERVO 1 · BASE" />



            <Diagnostic name="SERVO 2 · SHOULDER" />



            <Diagnostic name="SERVO 3 · ELBOW" />



            <Diagnostic name="SERVO 4 · WRIST" />



            <Diagnostic name="DS18B20" />



            <Diagnostic name="MPU6050" />



          </div>



        </section>







        <section className="panel event-panel">



          <PanelHeader



            number="07"



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
        <span>CONTROL {controlMode}</span>



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



}) {



  const knobX = ((x - 2048) / 2048) * 42;



  const knobY = ((y - 2048) / 2048) * 42;







  return (



    <div className="joystick">



      <div className="joystick-name">{name}</div>







      <div className="joystick-circle">



        <div className="joystick-cross horizontal" />



        <div className="joystick-cross vertical" />







        <div



          className="joystick-knob"



          style={{



            transform: `translate(${knobX}px, ${knobY}px)`,



          }}



        />



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



    </div>



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