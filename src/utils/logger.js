const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";

const C = {
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[97m",
  gray:    "\x1b[90m",
};

function ts() {
  return `${D}${C.gray}${new Date().toTimeString().slice(0, 8)}${R}`;
}

function tag(color, label) {
  return `${color}${B}[${label}]${R}`;
}

const logger = {
  info:   (...a) => console.log  (tag(C.cyan,    " INFO "), ts(), ...a),
  ok:     (...a) => console.log  (tag(C.green,   "  OK  "), ts(), ...a),
  warn:   (...a) => console.warn (tag(C.yellow,  " WARN "), ts(), ...a),
  error:  (...a) => console.error(tag(C.red,     "ERROR "), ts(), ...a),
  debug:  (...a) => console.log  (tag(C.magenta, "DEBUG "), ts(), ...a),
  db:     (...a) => console.log  (tag(C.blue,    "  DB  "), ts(), ...a),
  auth:   (...a) => console.log  (tag(C.yellow,  " AUTH "), ts(), ...a),
  sms:    (...a) => console.log  (tag(C.magenta, " SMS  "), ts(), ...a),
  server: (...a) => console.log  (tag(C.green,   " SERV "), ts(), ...a),

  banner(lines) {
    const W      = 55;
    const border = `${C.cyan}${B}${"═".repeat(W)}${R}`;
    console.log(`\n${border}`);
    for (const line of lines) {
      const text = `  ${line}`;
      const pad  = " ".repeat(Math.max(0, W - text.length - 1));
      console.log(`${C.cyan}${B}║${R}${C.white}${text}${pad}${C.cyan}${B}║${R}`);
    }
    console.log(`${border}\n`);
  },
};

module.exports = logger;
