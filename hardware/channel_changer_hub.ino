/*
  Channel Changer - audience knob hub
  -----------------------------------
  Board:  Arduino Nano (ATmega328P) or Uno
  Reads up to 32 seven-position knob boxes through two CD74HC4067
  16-channel analog multiplexers and sends their positions to the
  show laptop over USB.

  Each knob box holds a ladder of 8 x 1k resistors between +5V (ring)
  and GND (sleeve). The 7 taps go to the 7 positions of a rotary switch,
  and the switch common goes back on the tip. So every position gives
  its own voltage on a single wire.

  Serial output (115200 baud), every 50 ms:
    K130200041722...   'K' followed by one digit per knob
                       1-7 = channel the knob points at
                       0   = unplugged (or a fault)

  Send 'r' from the Serial Monitor to toggle raw mode, which prints
  the ADC reading of every knob instead. Use it to test each box:
  readings should sit near 124, 249, 373, 497, 622, 746, 871.
*/

const uint8_t NUM_KNOBS = 30;   // knob boxes actually wired (max 32)
const uint8_t POSITIONS = 7;

// Multiplexer select lines S0..S3, shared by both mux boards
const uint8_t SELECT_PINS[4] = {2, 3, 4, 5};
// Mux A (knobs 1-16) -> A0, Mux B (knobs 17-32) -> A1
const uint8_t SIGNAL_PINS[2] = {A0, A1};

// Ladder values. R_FEED is the protection resistor on each jack's +5V in the hub.
const float R_LADDER = 1000.0;
const float R_FEED   = 220.0;
const float STEP      = 1023.0 * R_LADDER / (8.0 * R_LADDER + R_FEED); // ~124 ADC counts per position
const float TOLERANCE = STEP * 0.35;  // max distance from a tap to still count as that position

// Debounce: a new position must read the same for this many scans in a row.
// "Unplugged" needs much longer so a switch passing between contacts
// is never reported as a missing knob. One scan of 30 knobs takes ~15 ms.
const uint8_t STABLE_SCANS  = 3;
const uint8_t UNPLUG_SCANS  = 20;
const unsigned long SEND_INTERVAL_MS = 50;

uint8_t reported[32];
uint8_t candidate[32];
uint8_t candidateCount[32];
int lastAdc[32];
bool rawMode = false;
unsigned long lastSend = 0;

void selectChannel(uint8_t ch) {
  for (uint8_t i = 0; i < 4; i++) digitalWrite(SELECT_PINS[i], (ch >> i) & 1);
}

int median3(int a, int b, int c) {
  int t;
  if (a > b) { t = a; a = b; b = t; }
  if (b > c) { t = b; b = c; c = t; }
  if (a > b) { t = a; a = b; b = t; }
  return b;
}

int readKnobAdc(uint8_t knob) {
  uint8_t pin = SIGNAL_PINS[knob / 16];
  selectChannel(knob % 16);
  delayMicroseconds(40);
  analogRead(pin);                 // discard the first reading after switching channel
  int a = analogRead(pin);
  int b = analogRead(pin);
  int c = analogRead(pin);
  return median3(a, b, c);
}

uint8_t adcToPosition(int adc) {
  int n = (int)(adc / STEP + 0.5);
  if (n < 1 || n > POSITIONS) return 0;
  if (fabs(adc - n * STEP) > TOLERANCE) return 0;
  return (uint8_t)n;
}

void setup() {
  for (uint8_t i = 0; i < 4; i++) pinMode(SELECT_PINS[i], OUTPUT);
  for (uint8_t k = 0; k < 32; k++) {
    reported[k] = 0;
    candidate[k] = 0;
    candidateCount[k] = 0;
    lastAdc[k] = 0;
  }
  Serial.begin(115200);
}

void scanKnobs() {
  for (uint8_t k = 0; k < NUM_KNOBS; k++) {
    int adc = readKnobAdc(k);
    lastAdc[k] = adc;
    uint8_t pos = adcToPosition(adc);

    if (pos == reported[k]) {          // nothing new
      candidateCount[k] = 0;
      continue;
    }
    if (pos == candidate[k]) {
      candidateCount[k]++;
    } else {
      candidate[k] = pos;
      candidateCount[k] = 1;
    }
    uint8_t needed = (pos == 0) ? UNPLUG_SCANS : STABLE_SCANS;
    if (candidateCount[k] >= needed) {
      reported[k] = pos;
      candidateCount[k] = 0;
    }
  }
}

void loop() {
  scanKnobs();

  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'r' || c == 'R') rawMode = !rawMode;
  }

  if (millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    if (rawMode) {
      Serial.print('R');
      for (uint8_t k = 0; k < NUM_KNOBS; k++) {
        Serial.print(',');
        Serial.print(lastAdc[k]);
      }
    } else {
      Serial.print('K');
      for (uint8_t k = 0; k < NUM_KNOBS; k++) Serial.print(reported[k]);
    }
    Serial.println();
  }
}
