const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const ws = require("ws");
const zlib = require("zlib");

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0"; // Vercel'de çalışacak şekilde ayarlandı.
const port = process.env.PORT || 3000;
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const signalrUrl = "livetiming.formula1.com/signalr";
const signalrHub = "Streaming";

const socketFreq = 1000;
const retryFreq = 10000;

let state = {};
let messageCount = 0;
let emptyMessageCount = 0;

const deepObjectMerge = (original = {}, modifier) => {
  if (!modifier) return original;
  const copy = { ...original };
  for (const [key, value] of Object.entries(modifier)) {
    const valueIsObject =
      typeof value === "object" && !Array.isArray(value) && value !== null;
    if (valueIsObject && !!Object.keys(value).length) {
      copy[key] = deepObjectMerge(copy[key], value);
    } else {
      copy[key] = value;
    }
  }
  return copy;
};

const parseCompressed = (data) =>
  JSON.parse(zlib.inflateRawSync(Buffer.from(data, "base64")).toString());

const updateState = (data) => {
  try {
    const parsed = JSON.parse(data.toString());

    if (!Object.keys(parsed).length) emptyMessageCount++;
    else emptyMessageCount = 0;

    if (emptyMessageCount > 5 && !dev) {
      state = {};
      messageCount = 0;
    }

    if (Array.isArray(parsed.M)) {
      for (const message of parsed.M) {
        if (message.M === "feed") {
          messageCount++;

          let [field, value] = message.A;

          if (field === "CarData.z" || field === "Position.z") {
            const [parsedField] = field.split(".");
            field = parsedField;
            value = parseCompressed(value);
          }

          state = deepObjectMerge(state, { [field]: value });
        }
      }
    } else if (Object.keys(parsed.R ?? {}).length && parsed.I === "1") {
      messageCount++;

      if (parsed.R["CarData.z"])
        parsed.R["CarData"] = parseCompressed(parsed.R["CarData.z"]);

      if (parsed.R["Position.z"])
        parsed.R["Position"] = parseCompressed(parsed.R["Position.z"]);

      state = deepObjectMerge(state, parsed.R);
    }
  } catch (e) {
    console.error(`could not update data: ${e}`);
  }
};

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const wss = new ws.Server({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    console.log("New WebSocket connection");

    socket.on("message", (message) => {
      console.log("Received:", message);
    });

    socket.on("close", () => {
      console.log("WebSocket connection closed");
    });

    // Periodically send the state to clients
    const interval = setInterval(() => {
      if (socket.readyState === ws.OPEN) {
        socket.send(JSON.stringify(state));
      } else {
        clearInterval(interval);
      }
    }, socketFreq);
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
