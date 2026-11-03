// StatusLight.ino: bench firmware for the status-master desk light on a Teknic ClearCore.
//
// Wiring: IO-4 = red, IO-5 = green. Both on mixes to orange.
//
// On boot it runs a self-test (red, green, orange, off, one second each), then takes line commands over the
// USB serial port (115200 baud, newline-terminated):
//   red | green | orange | off      (or r, g, o, x)
//   ?                               prints the current color
// Each command answers "ok <color>". This proves the wiring and the flash path before MQTT exists; the MQTT
// subscriber comes next.
//
// FQBN: ClearCore:sam:clearcore
// Flash: ~/d3v/teknic-clearcore-cli/scripts/flash.sh firmware/StatusLight

#include "ClearCore.h"

#define RED_OUT ConnectorIO4
#define GREEN_OUT ConnectorIO5

enum Color { OFF, RED, GREEN, ORANGE };
static const char *const COLOR_NAMES[] = {"off", "red", "green", "orange"};

static Color current = OFF;
static char line[32];
static uint8_t lineLen = 0;

static void show(Color c) {
    RED_OUT.State(c == RED || c == ORANGE);
    GREEN_OUT.State(c == GREEN || c == ORANGE);
    current = c;
}

static bool parse(const char *cmd, Color *out) {
    if (!strcmp(cmd, "red") || !strcmp(cmd, "r")) *out = RED;
    else if (!strcmp(cmd, "green") || !strcmp(cmd, "g")) *out = GREEN;
    else if (!strcmp(cmd, "orange") || !strcmp(cmd, "o")) *out = ORANGE;
    else if (!strcmp(cmd, "off") || !strcmp(cmd, "x")) *out = OFF;
    else return false;
    return true;
}

static void handle(char *cmd) {
    // Trim trailing spaces and lower-case in place.
    uint8_t n = strlen(cmd);
    while (n && cmd[n - 1] == ' ') cmd[--n] = '\0';
    for (uint8_t i = 0; i < n; i++) cmd[i] = tolower(cmd[i]);
    if (n == 0) return;

    Color c;
    if (!strcmp(cmd, "?")) {
        Serial.print("ok ");
        Serial.println(COLOR_NAMES[current]);
    } else if (parse(cmd, &c)) {
        show(c);
        Serial.print("ok ");
        Serial.println(COLOR_NAMES[c]);
    } else {
        Serial.println("? use red, green, orange, off or ?");
    }
}

void setup() {
    RED_OUT.Mode(Connector::OUTPUT_DIGITAL);
    GREEN_OUT.Mode(Connector::OUTPUT_DIGITAL);
    show(OFF);
    pinMode(LED_BUILTIN, OUTPUT);
    Serial.begin(115200);

    // Self-test, so the wiring can be checked by eye after every flash.
    const Color test[] = {RED, GREEN, ORANGE, OFF};
    for (Color c : test) {
        show(c);
        delay(1000);
    }
    Serial.println("StatusLight ready: red, green, orange, off or ?");
}

void loop() {
    // Heartbeat on the USR LED: 1 s period, so a hung sketch is easy to spot.
    digitalWrite(LED_BUILTIN, (millis() / 500) % 2);

    while (Serial.available() > 0) {
        int ch = Serial.read();
        if (ch == '\r') continue;
        if (ch == '\n') {
            line[lineLen] = '\0';
            handle(line);
            lineLen = 0;
        } else if (lineLen < sizeof(line) - 1) {
            line[lineLen++] = (char)ch;
        }
    }
}
