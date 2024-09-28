module.exports = {
  apps: [
    {
      name: "nemea-agent",
      script: "agent.js",
      //   instances: "max",
      exec_mode: "cluster",
      watch: false,
      env: {
        NODE_ENV: "production",
        API_KEY: process.env.API_KEY,
        CONFIG_URL: process.env.CONFIG_URL,
        GEO_API_KEY: process.env.GEO_API_KEY,
      },
    },
  ],
};
