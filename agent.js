require("dotenv").config();
const axios = require("axios");
const dns = require("node:dns");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const WebSocket = require("ws");
const ping = require("ping");
const {
  setIntervalAsync,
  clearIntervalAsync,
} = require("set-interval-async/dynamic");
const EventEmitter = require("events");
const winston = require("winston");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({filename: "error.log", level: "error"}),
  ],
});

logger.info("Nemea Agent started.");

// Used until the server answers. Every one of these was a literal scattered through
// this file; they are here so there is one place to see what an unconfigured agent
// does, and so the server can change any of them without a release.
const FALLBACK_SETTINGS = {
  pingCount: 5,
  pingTimeout: 5000,
  dnsTimeout: 10000,
  dnsServers: [],
  dnsUseSystemFallback: true,
  monitorPollInterval: 30000,
  configPollInterval: 30000,
  heartbeatInterval: 30000,
  retryDelay: 5000,
  monitorRetryDelay: 30000,
  geoCacheSeconds: 3600,
};

class NemeaAgent extends EventEmitter {
  constructor(apiKey, configUrl, geoApiKey) {
    super();
    this.apiKey = apiKey;
    this.configUrl = configUrl;
    this.geoApiKey = geoApiKey || null;
    this.monitors = [];
    this.config = null;
    this.refreshInterval = null;

    // Identity. `apiKey` is the shared enrolment key and gets us through the door
    // exactly once; `token` is this agent's own and is what everything else uses.
    this.agentId = null;
    this.token = process.env.AGENT_TOKEN || null;
    this.statePath =
      process.env.AGENT_STATE_FILE || path.join(__dirname, "state", "agent.json");

    // Server-controlled. Replaced wholesale on every heartbeat.
    this.settings = {...FALLBACK_SETTINGS};
    // Set false from the console to stop measuring without deleting the agent. It
    // keeps heartbeating while paused, because that is how it finds out it is back on.
    this.enabled = true;
    this.running = false;

    this.geoCache = null;
    this.geoCacheTimestamp = 0;

    // The live channel. Monitors are polled work and do not need one; an on-demand
    // measurement is somebody waiting on an answer, and a thirty-second poll cannot
    // serve that.
    this.socket = null;
    this.socketRetry = 1000;
  }

  /**
   * Hold a socket open to the API so work can be pushed here.
   *
   * Reconnects with backoff and never gives up: an agent whose socket died at 3am
   * should be answering measurements again by morning without anybody noticing. The
   * polling loops keep running throughout, so a dead socket costs on-demand
   * measurements and nothing else.
   */
  connectSocket() {
    if (!this.token) return;

    const url = `${this.configUrl.replace(/^http/, "ws")}/ws/nemea/agent`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on("open", () => {
      socket.send(JSON.stringify({type: "auth", token: this.token}));
    });

    socket.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === "ready") {
        this.socketRetry = 1000;
        logger.info("Socket connected; ready for on-demand measurements");
        return;
      }

      if (message.type === "measure") {
        await this.runOnDemand(message.id, message.job);
      }
    });

    socket.on("close", (code) => {
      this.socket = null;
      // 4401 is a rejected token. Retrying every second with a credential the
      // server has already refused is just noise in somebody's logs.
      const delay = code === 4401 ? 60000 : this.socketRetry;
      logger.warn(`Socket closed (${code}); reconnecting in ${delay} ms`);
      setTimeout(() => this.connectSocket(), delay);
      this.socketRetry = Math.min(this.socketRetry * 2, 60000);
    });

    socket.on("error", (error) => {
      logger.debug(`Socket error: ${error.message}`);
    });
  }

  /**
   * Run one measurement for somebody who is waiting, and forget it.
   *
   * Nothing here touches the monitor list or the ingest endpoint. The result goes
   * back down the socket that asked for it and is never stored on this side.
   */
  async runOnDemand(id, job) {
    const send = (payload) => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({type: "result", id, ...payload}));
      }
    };

    // The API refuses obvious private targets, but it cannot know what a hostname
    // resolves to from here - and "here" is the whole point of a probe network.
    // Resolving locally and checking is the only place that check can be correct.
    const refusal = await this.refusePrivate(job.target);
    if (refusal) {
      logger.warn(`Refused on-demand measurement of ${job.target}: ${refusal}`);
      send({error: refusal});
      return;
    }

    try {
      const result =
        job.type === "DNS"
          ? await this.monitorDNS(job.recordType || "A", job.target, null)
          : await this.monitorPing(job.target);
      send({result});
    } catch (error) {
      send({error: error.message});
    }
  }

  /** Does this target resolve to somewhere that is nobody else's business? */
  async refusePrivate(target) {
    const isPrivate = (address) =>
      /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address) ||
      address === "::1" ||
      address.startsWith("fe80") ||
      address.startsWith("fc") ||
      address.startsWith("fd");

    if (isPrivate(target)) return "That address is not public";

    try {
      const {address} = await dns.promises.lookup(target);
      if (isPrivate(address)) return "That name resolves to a private address";
    } catch {
      return "That name does not resolve";
    }
    return null;
  }

  /**
   * The credential for everything except enrolment.
   *
   * Falls back to the shared key so an agent that cannot enrol - an older API, a
   * network blip during first boot - keeps measuring instead of going dark. Its
   * samples land unattributed, which is worse than attributed and much better than
   * nothing.
   */
  authHeader() {
    return {Authorization: `Bearer ${this.token || this.apiKey}`};
  }

  /**
   * Load this agent's identity from disk, enrolling if it has none.
   *
   * The token is written to a file rather than held in memory because the container
   * is replaced on every update by watchtower; without this, each new image would
   * enrol a fresh agent and the old one would sit in the console going stale forever.
   */
  async enrol() {
    if (this.token) {
      logger.info("Using the agent token from the environment");
      return;
    }

    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (saved.token) {
        this.token = saved.token;
        this.agentId = saved.agentId || null;
        logger.info(`Resuming as agent ${this.agentId || "(id unknown)"}`);
        return;
      }
    } catch {
      // No state file yet. That is the normal first boot, not an error.
    }

    if (!this.apiKey) {
      logger.error("No API_KEY and no stored token - cannot enrol");
      return;
    }

    try {
      const location = await this.getGeolocation();
      const response = await axios.post(
        `${this.configUrl}/v1/nemea/agents/register`,
        {
          name: process.env.AGENT_NAME || undefined,
          hostname: os.hostname(),
          version: require("./package.json").version,
          location: location || {},
        },
        {headers: {Authorization: `Bearer ${this.apiKey}`}}
      );

      this.token = response.data.token;
      this.agentId = response.data.agent.id;
      this.saveState();
      logger.info(
        `Enrolled as "${response.data.agent.name}" (${this.agentId})`
      );
    } catch (error) {
      this.handleError("enrolling", error);
      logger.warn("Continuing on the shared key; samples will be unattributed");
    }
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), {recursive: true});
      fs.writeFileSync(
        this.statePath,
        JSON.stringify({agentId: this.agentId, token: this.token}, null, 2),
        // The token is a credential: readable by the user that runs the agent only.
        {mode: 0o600}
      );
    } catch (error) {
      logger.error(
        `Could not save agent state to ${this.statePath}: ${error.message}. ` +
          "This agent will enrol again as a new one when it restarts."
      );
    }
  }

  /**
   * Report in, and collect settings in the same call.
   *
   * One round trip rather than a heartbeat plus a config poll: the server has to
   * write `last_seen_at` either way, and it may as well answer with what changed.
   */
  async heartbeat() {
    if (!this.token) return;
    try {
      const response = await axios.post(
        `${this.configUrl}/v1/nemea/agents/heartbeat`,
        {
          version: require("./package.json").version,
          hostname: os.hostname(),
          location: (await this.getGeolocation()) || undefined,
        },
        {headers: this.authHeader()}
      );
      await this.applySettings(response.data.config, response.data.enabled);
    } catch (error) {
      this.handleError("sending heartbeat", error);
    }
  }

  /**
   * Take the server's settings, and restart monitoring only if it matters.
   *
   * Intervals are baked into timers when monitoring starts, so a changed interval
   * needs a restart to take effect - but restarting on every heartbeat would throw
   * away in-flight measurements thirty seconds at a time.
   */
  async applySettings(config, enabled) {
    if (config && typeof config === "object") {
      const before = this.settings;
      this.settings = {...FALLBACK_SETTINGS, ...config};

      const timingChanged = [
        "monitorPollInterval",
        "configPollInterval",
        "heartbeatInterval",
      ].some((key) => before[key] !== this.settings[key]);

      if (timingChanged) {
        logger.info("Timing settings changed; restarting schedules");
        await this.restartMonitoring();
      }
    }

    if (enabled !== undefined && enabled !== this.enabled) {
      this.enabled = enabled;
      logger.info(enabled ? "Enabled by the console" : "Paused by the console");
      if (enabled) await this.restartMonitoring();
      else await this.stopMonitoring();
    }
  }

  async fetchConfig() {
    logger.debug("Fetching config from API");
    try {
      const response = await axios.get(`${this.configUrl}/v1/nemea/config`, {
        headers: this.authHeader(),
      });
      this.config = response.data;
      // An enrolled agent gets its own settings back on this call too.
      await this.applySettings(response.data.config, response.data.enabled);
      logger.debug("Config fetched successfully:", this.config);

      if (!this.refreshInterval) {
        this.refreshInterval = this.config.monitorRefreshInterval || 60000;
        logger.info(
          `Initial monitor refresh interval set to ${this.refreshInterval} ms`
        );
      }

      this.emit("configFetched");
    } catch (error) {
      this.handleError("fetching config", error);
    }
  }

  async fetchMonitors() {
    logger.debug("Fetching monitors from API");
    try {
      const response = await axios.get(`${this.configUrl}/v1/nemea/monitors`, {
        headers: this.authHeader(),
      });

      // Check if the response indicates failure
      if (!response.data.success) {
        logger.warn(response.data.message);
        this.retryFetchMonitors();
        return; // Exit the function early
      }

      this.monitors = response.data.monitors.map((monitor) => ({
        id: monitor.id,
        type: monitor.type,
        recordType: monitor.record_type,
        domain: monitor.domain,
        server: monitor.server,
        host: monitor.host,
        interval: monitor.interval,
      }));

      logger.debug("Monitors fetched successfully:", this.monitors);
      this.emit("monitorsFetched");
    } catch (error) {
      this.handleError("fetching monitors", error);
    }
  }

  retryFetchMonitors() {
    const delay = this.settings.monitorRetryDelay;
    logger.info(`Retrying to fetch monitors in ${delay} ms...`);
    setTimeout(() => {
      this.fetchMonitors();
    }, delay);
  }

  handleError(action, error) {
    if (error.response) {
      logger.error(
        `Failed to ${action}: HTTP ${error.response.status} - ${error.response.statusText}`
      );
      switch (error.response.status) {
        case 502:
        case 500: {
          const delay = this.settings.retryDelay;
          logger.warn(
            `Received ${error.response.status} from the API. Retrying in ${delay} ms...`
          );
          setTimeout(() => {
            if (action === "fetching config") this.fetchConfig();
            if (action === "fetching monitors") this.fetchMonitors();
          }, delay);
          break;
        }
        case 404:
          logger.error("Resource not found. Please check the URL.");
          break;
        case 401:
        case 403:
          logger.error(
            "Rejected by the API. If this agent was removed from the console its " +
              "token is dead - delete the state file to enrol again."
          );
          break;
        default:
          logger.error("Unhandled HTTP error occurred.");
      }
    } else {
      logger.error(`Failed to ${action}: ${error.message}`);
    }
  }

  async monitorDNS(recordType, domain, server) {
    logger.debug(
      `Monitoring DNS: ${recordType} for ${domain} using server: ${
        server || "default"
      }`
    );
    // A monitor naming a resolver wins; otherwise this agent's configured ones; and
    // failing both, whatever the machine itself uses - which is usually the honest
    // measurement, since it is what somebody at this location would actually get.
    const resolvers = server
      ? [server]
      : this.settings.dnsServers?.length
        ? this.settings.dnsServers
        : null;
    if (resolvers) dns.setServers(resolvers);

    try {
      let result;
      switch (recordType) {
        case "A":
          result = await new Promise((resolve, reject) => {
            dns.resolve4(
              domain,
              {ttl: true, timeout: this.settings.dnsTimeout},
              (err, addresses) => {
                if (err) reject(err);
                else resolve(addresses);
              }
            );
          });
          break;
        case "AAAA":
          result = await new Promise((resolve, reject) => {
            dns.resolve6(
              domain,
              {ttl: true, timeout: this.settings.dnsTimeout},
              (err, addresses) => {
                if (err) reject(err);
                else resolve(addresses);
              }
            );
          });
          break;
        case "SOA":
          result = await new Promise((resolve, reject) => {
            dns.resolveSoa(domain, (err, soaRecord) => {
              if (err) reject(err);
              else resolve(soaRecord);
            });
          });
          break;
        case "CNAME":
          result = await new Promise((resolve, reject) => {
            dns.resolveCname(domain, (err, cnameRecords) => {
              if (err) reject(err);
              else resolve(cnameRecords);
            });
          });
          break;
        default:
          throw new Error("Unsupported record type");
      }

      const detailedResult = {
        recordType,
        domain,
        server: server || "default",
        records: result,
      };
      if (recordType === "SOA") {
        detailedResult.hostmaster = result.hostmaster;
        detailedResult.serial = result.serial;
      }

      logger.debug("DNS monitoring result:", detailedResult);
      return detailedResult;
    } catch (error) {
      logger.error(`Error resolving DNS for ${domain}:`, error);
      return null;
    }
  }

  async monitorPing(host) {
    logger.debug(`Pinging host: ${host}`);
    const pingResults = [];
    const pingCount = this.settings.pingCount;

    for (let i = 0; i < pingCount; i++) {
      try {
        const res = await ping.promise.probe(host, {
          timeout: Math.ceil(this.settings.pingTimeout / 1000),
        });
        if (res.alive) {
          pingResults.push(res.time);
          logger.debug(`Ping response time for ${host}: ${res.time} ms`);
        } else {
          logger.warn(`Host ${host} is not alive.`);
        }
      } catch (error) {
        logger.error(`Error pinging ${host}:`, error);
      }
    }

    if (pingResults.length > 0) {
      const min = Math.min(...pingResults);
      const max = Math.max(...pingResults);
      const avg = pingResults.reduce((a, b) => a + b, 0) / pingResults.length;
      const packetLoss = ((pingCount - pingResults.length) / pingCount) * 100;

      const pingSummary = {min, max, avg, packetLoss, times: pingResults};
      logger.debug("Ping results summary:", pingSummary);
      return pingSummary;
    } else {
      logger.warn(`No successful ping responses from ${host}.`);
      return null;
    }
  }

  async getGeolocation() {
    if (!this.geoApiKey) {
      logger.warn("Geolocation API key is not provided. Skipping geolocation.");
      return null;
    }

    const currentTime = Date.now();

    if (
      this.geoCache &&
      currentTime - this.geoCacheTimestamp < this.settings.geoCacheSeconds * 1000
    ) {
      logger.debug("Using cached geolocation data.");
      return this.geoCache;
    }

    logger.debug("Fetching geolocation data from API");
    try {
      const response = await axios.get(
        `https://ipinfo.io/json?token=${this.geoApiKey}`
      );
      this.geoCache = response.data;
      this.geoCacheTimestamp = currentTime;
      logger.debug("Geolocation data fetched successfully:", this.geoCache);
      return this.geoCache;
    } catch (error) {
      logger.error("Failed to fetch geolocation data:", error);
      return null;
    }
  }

  async sendResults(results) {
    logger.debug("Sending results to API:", results);
    try {
      const geoData = await this.getGeolocation();
      if (geoData) {
        results.systemID = geoData;
      }

      await axios.post(`${this.configUrl}/v1/nemea/ingest`, results, {
        headers: this.authHeader(),
      });
      logger.info(
        `Results for ${results.monitorId} (${results.monitorType}) sent successfully`
      );
    } catch (error) {
      this.handleError("sending results", error);
    }
  }

  async checkForNewMonitors() {
    logger.debug("Checking for new monitors");
    const previousMonitors = this.monitors.slice();
    await this.fetchMonitors();

    const hasChanged =
      JSON.stringify(previousMonitors) !== JSON.stringify(this.monitors);
    if (hasChanged) {
      logger.info("Monitors updated:", this.monitors);
      await this.restartMonitoring();
    }
  }

  async checkConfigChanges() {
    logger.debug("Checking for config changes");
    try {
      const response = await axios.get(`${this.configUrl}/v1/nemea/config`, {
        headers: this.authHeader(),
      });
      await this.applySettings(response.data.config, response.data.enabled);
      const newRefreshInterval = response.data.monitorRefreshInterval || 60000;

      if (this.refreshInterval !== newRefreshInterval) {
        this.refreshInterval = newRefreshInterval;
        logger.info(
          `Monitor refresh interval updated to ${this.refreshInterval} ms`
        );
      }
    } catch (error) {
      logger.error("Failed to check for config changes:", error);
    }
  }

  async restartMonitoring() {
    logger.info("Restarting monitoring");
    await this.stopMonitoring();
    await this.startMonitoring();
  }

  async startMonitoring() {
    if (this.running) return;
    this.running = true;

    // The schedules run even while paused: a paused agent still has to report in,
    // or it can never be told it has been switched back on.
    this.connectSocket();

    this.schedules = [
      // Doubles as the socket's keepalive: the server refreshes last_seen_at from
      // whichever arrives, so an agent with a live socket stays online even if an
      // HTTP heartbeat fails.
      setIntervalAsync(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({type: "ping"}));
        }
        return this.heartbeat();
      }, this.settings.heartbeatInterval),
      setIntervalAsync(
        () => this.checkConfigChanges(),
        this.settings.configPollInterval
      ),
      setIntervalAsync(
        () => this.checkForNewMonitors(),
        this.settings.monitorPollInterval
      ),
    ];

    if (!this.enabled) {
      logger.info("Paused by the console - reporting in, but not measuring");
      return;
    }

    logger.info("Starting monitoring");
    await this.fetchMonitors();

    this.monitorIntervals = this.monitors.map((monitor) => {
      return setIntervalAsync(async () => {
        let result = null;

        if (monitor.type === "DNS") {
          result = await this.monitorDNS(
            monitor.recordType,
            monitor.domain,
            monitor.server
          );
        } else if (monitor.type === "PING") {
          result = await this.monitorPing(monitor.host);
        }

        if (result) {
          await this.sendResults({
            monitorId: monitor.id,
            result,
            monitorType: monitor.type,
          });
        }
      }, monitor.interval || 60000);
    });
  }

  async stopMonitoring() {
    logger.info("Stopping monitoring");
    this.running = false;
    // 1000 so the close handler does not schedule a reconnect for a socket we are
    // deliberately closing.
    if (this.socket) {
      this.socket.removeAllListeners("close");
      this.socket.close(1000);
      this.socket = null;
    }
    for (const interval of this.monitorIntervals ?? []) {
      await clearIntervalAsync(interval);
    }
    this.monitorIntervals = [];
    for (const schedule of this.schedules ?? []) {
      await clearIntervalAsync(schedule);
    }
    this.schedules = [];
  }
}

const agent = new NemeaAgent(
  process.env.API_KEY, // main API key
  process.env.CONFIG_URL, // config URL
  process.env.GEO_API_KEY // geo API key
);

// Identity first: enrolment decides which credential every later call carries, and
// the first heartbeat is what puts this agent on the console's fleet list before it
// has taken a single measurement.
agent.on("configFetched", () => agent.startMonitoring());
(async () => {
  await agent.enrol();
  await agent.heartbeat();
  await agent.fetchConfig();
})();

// Exit Handlers
process.on("SIGTERM", async () => {
  logger.info("SIGTERM signal received: closing agent gracefully");
  await agent.stopMonitoring();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT signal received: closing agent gracefully");
  await agent.stopMonitoring();
  process.exit(0);
});
