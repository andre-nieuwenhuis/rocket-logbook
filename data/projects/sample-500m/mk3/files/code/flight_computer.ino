// Sample file: replace with your own flight code.
// Detects launch and apogee from a pressure sensor and fires the parachute.

const int   PYRO_PIN       = 5;
const float LAUNCH_RISE_M  = 8.0;    // climb needed to call it a launch
const int   CONFIRM_COUNT  = 6;      // readings in a row that must show descent
const unsigned long BACKUP_MS = 11000;

float filtered = 0, peak = 0, ground = 0;
int   falling = 0;
bool  launched = false, deployed = false;
unsigned long launchTime = 0;

void setup() {
  pinMode(PYRO_PIN, OUTPUT);
  ground = readAltitude();
  filtered = ground;
}

void loop() {
  float raw = readAltitude();
  filtered = 0.85 * filtered + 0.15 * raw;   // low-pass filter

  if (!launched && filtered - ground > LAUNCH_RISE_M) {
    launched = true;
    launchTime = millis();
  }

  if (launched && !deployed) {
    if (filtered > peak) { peak = filtered; falling = 0; }
    else if (peak - filtered > 1.5) falling++;

    bool apogee = falling >= CONFIRM_COUNT;
    bool backup = millis() - launchTime > BACKUP_MS;
    if (apogee || backup) deploy();
  }
  delay(20);
}

void deploy() {
  digitalWrite(PYRO_PIN, HIGH);
  deployed = true;
}

float readAltitude() {
  return 0.0;   // read your barometer here
}
