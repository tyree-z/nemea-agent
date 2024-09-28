/* 
I know I could've built this "agent" in a faster language, but I wanted to go with JavaScript for its flexibility. 
*/
const axios = require("axios");
const dns = require("dns").promises;
const ping = require("ping");
const {
  setIntervalAsync,
  clearIntervalAsync,
} = require("set-interval-async/dynamic");
const EventEmitter = require("events");
const http = require("http");
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

class NemeaAgent extends EventEmitter {
  constructor(apiKey, configUrl, geoApiKey) {
    super();
    this.apiKey = apiKey;
    this.configUrl = configUrl;
    this.geoApiKey = geoApiKey || null;
    this.monitors = [];
    this.config = null;
    this.refreshInterval = null;

    // Caching variables for geolocation
    this.geoCache = null;
    this.geoCacheTimestamp = 0;
    this.CACHE_EXPIRATION = 60 * 1000;
  }

  async fetchConfig() {
    logger.debug("Fetching config from API");
    try {
      const response = await axios.get(`${this.configUrl}/v1/nemea/config`, {
        headers: {Authorization: `Bearer ${this.apiKey}`},
      });
      this.config = response.data;
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
        headers: {Authorization: `Bearer ${this.apiKey}`},
      });
      this.monitors = response.data.monitors;
      logger.debug("Monitors fetched successfully:", this.monitors);
      this.emit("monitorsFetched");
    } catch (error) {
      this.handleError("fetching monitors", error);
    }
  }

  handleError(action, error) {
    if (error.response) {
      logger.error(
        `Failed to ${action}: HTTP ${error.response.status} - ${error.response.statusText}`
      );
      switch (error.response.status) {
        case 502:
          logger.warn("Received 502 Bad Gateway. Retrying in 5 seconds...");
          setTimeout(() => {
            if (action === "fetching config") this.fetchConfig();
            if (action === "fetching monitors") this.fetchMonitors();
          }, 5000);
          break;
        case 500:
          logger.warn(
            "Received 500 Internal Server Error. Retrying in 5 seconds..."
          );
          setTimeout(() => {
            if (action === "fetching config") this.fetchConfig();
            if (action === "fetching monitors") this.fetchMonitors();
          }, 5000);
          break;
        case 404:
          logger.error("Resource not found. Please check the URL.");
          break;
        case 403:
          logger.error("Access forbidden. Please check API key.");
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
    if (server) dns.setServers([server]);

    try {
      let result;
      switch (recordType) {
        case "A":
          result = await dns.resolve4(domain, {ttl: true});
          break;
        case "AAAA":
          result = await dns.resolve6(domain, {ttl: true});
          break;
        case "SOA":
          result = await dns.resolveSoa(domain);
          break;
        case "CNAME":
          result = await dns.resolveCname(domain);
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
    const pingCount = 5;

    for (let i = 0; i < pingCount; i++) {
      try {
        const res = await ping.promise.probe(host);
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
      currentTime - this.geoCacheTimestamp < this.CACHE_EXPIRATION
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
        headers: {Authorization: `Bearer ${this.apiKey}`},
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
        headers: {Authorization: `Bearer ${this.apiKey}`},
      });
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
    logger.info("Starting monitoring");
    await this.fetchMonitors();

    setIntervalAsync(() => this.checkConfigChanges(), 30000);
    setIntervalAsync(() => this.checkForNewMonitors(), 30000);

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
    if (this.monitorIntervals) {
      for (const interval of this.monitorIntervals) {
        await clearIntervalAsync(interval);
      }
    }
  }
}

const agent = new NemeaAgent(
  process.env.API_KEY, // main API key
  process.env.CONFIG_URL, // config URL
  process.env.GEO_API_KEY // geo API key
);

agent.on("configFetched", () => agent.startMonitoring());
agent.fetchConfig();

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
