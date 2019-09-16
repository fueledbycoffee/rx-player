#!/usr/bin/env node
/* eslint-env node */

/**
 * Run the full demo server
 * =========================
 *
 * This script allows to build the full demo locally and start both an HTTP and
 * an HTTPS (only if a certificate and key have been generated) server to serve
 * it, on the port 8000 and 8443 respectively.
 *
 * You can run it as a script through `node run_full_demo.js`.
 * Be aware that this demo will be built again every time either one of the
 * full demo file or one of the library file is updated.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const https = require("https");
const generateFullDemo = require("./generate_full_demo");
const getHumanReadableHours = require("./get_human_readable_hours");

generateFullDemo({ watch: true });

const HTTP_PORT = 8000;
const HTTPS_PORT = 8443;

const app = express();
app.use(express.static(path.join(__dirname, "../demo/full/")));

app.listen(HTTP_PORT, (err) => {
  if (err) {
    /* eslint-disable no-console */
    console.error(`\x1b[31m[${getHumanReadableHours()}]\x1b[0m ` +
                  "Could not start HTTP server:",
                  err);
    /* eslint-enable no-console */
    return;
  }
  /* eslint-disable no-console */
  console.log(`[${getHumanReadableHours()}] ` +
              `Listening HTTP at http://localhost:${HTTP_PORT}`);
  /* eslint-enable no-console */
});

Promise.all([
  promisify(fs.readFile)(path.join(__dirname, "../localhost.crt")),
  promisify(fs.readFile)(path.join(__dirname, "../localhost.key")),
]).then(([pubFile, privFile]) => {
  if (pubFile != null && privFile != null) {
    https.createServer({
      key: privFile,
      cert: pubFile,
    }, app).listen(HTTPS_PORT, (err) => {
      if (err) {
        /* eslint-disable no-console */
        console.error(`\x1b[31m[${getHumanReadableHours()}]\x1b[0m ` +
                      "Could not start HTTPS server:",
                      err);
        /* eslint-enable no-console */
        return;
      }
      /* eslint-disable no-console */
      console.log(`[${getHumanReadableHours()}] ` +
                  `Listening HTTPS at https://localhost:${HTTPS_PORT}`);
      /* eslint-enable no-console */
    });
  }
}, (err) => {
  if (err.code === "ENOENT") {
    /* eslint-disable no-console */
    console.warn(`[${getHumanReadableHours()}] ` +
                 "Not launching the demo in HTTPS: certificate not generated.\n" +
                 "You can run `npm run certificate` to generate a certificate.");
    /* eslint-enable no-console */
  } else {
    /* eslint-disable no-console */
    console.error(`\x1b[31m[${getHumanReadableHours()}]\x1b[0m ` +
                  "Could not readt keys and certificate:",
                  err);
    /* eslint-enable no-console */
  }
});