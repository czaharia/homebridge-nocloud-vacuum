'use strict';

/**
 * homebridge-nocloud-vacuum — platform.js
 *
 * Verified against: github.com/DGAlexandru/NoCloud (main branch, April 2026)
 *
 * MQTT topic reference (source-verified):
 * ─────────────────────────────────────────────────────────────────────────────
 * NoCloud/{id}/$name                                   → robot display name   (retained)
 * NoCloud/{id}/MapData/segments                        → {id:name, …} or {}  (retained)
 * NoCloud/{id}/StatusStateAttribute/status             → STATUS values        (retained)
 * NoCloud/{id}/StatusStateAttribute/flag               → FLAG values          (retained)
 *
 * NoCloud/{id}/MapSegmentationCapability/clean/set     ← clean payload        (write-only)
 * NoCloud/{id}/BasicControlCapability/operation/set    ← "HOME" plain string  (write-only)
 *
 * STATUS values  : error|docked|idle|returning|cleaning|paused|manual_control|moving
 * FLAG values    : none|zone|segment|spot|target|resumable|mapping
 *
 * A room switch is ON when:  status===cleaning  AND  flag===segment  AND  activeSegment===this room
 * (also shows ON when paused, so the user can cancel a paused segment job)
 *
 * NOTE: MapSegmentationCapability/clean has NO getter in NoCloud — never subscribe to it.
 * NOTE: MapData/segments publishes {} when the map is not yet loaded — guard against removing accessories.
 */

const mqtt = require('mqtt');
const { RoomAccessory } = require('./roomAccessory');

const PLUGIN_NAME   = 'homebridge-nocloud-vacuum';
const PLATFORM_NAME = 'NoCloudVacuumPlatform';

class NoCloudVacuumPlatform {

  constructor(log, config, api) {
    this.log    = log;
    this.config = config || {};
    this.api    = api;

    // uuid → PlatformAccessory (restored from Homebridge cache on startup)
    this.cachedAccessories = new Map();

    // deviceId → RobotState (see _newRobotState)
    this.robots = new Map();

    this.mqttClient = null;

    // Holds segments that arrived before the robot's $name was received
    this._pendingSegments = new Map(); // deviceId → parsed segments object

    if (!this.config.mqttUrl) {
      this.log.error('[NoCloud] No mqttUrl configured — plugin will not start.');
      return;
    }

    this.api.on('didFinishLaunching', () => this.connectMqtt());
    this.api.on('shutdown',           () => { if (this.mqttClient) this.mqttClient.end(true); });
  }

  // ─── Homebridge cache restore ──────────────────────────────────────────────

  configureAccessory(accessory) {
    this.log.debug(`[NoCloud] Cache restore: ${accessory.displayName}`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  // ─── MQTT connection ───────────────────────────────────────────────────────

  connectMqtt() {
    const url  = this.config.mqttUrl;
    const opts = { reconnectPeriod: 5000, connectTimeout: 30000 };
    if (this.config.mqttUsername) opts.username = this.config.mqttUsername;
    if (this.config.mqttPassword) opts.password = this.config.mqttPassword;

    this.log.info(`[NoCloud] Connecting to MQTT: ${url}`);
    this.mqttClient = mqtt.connect(url, opts);

    this.mqttClient.on('connect', () => {
      this.log.info('[NoCloud] MQTT connected — subscribing to discovery topics');
      const p = this.prefix;

      // Retained topics — delivered immediately on (re)connect
      this.mqttClient.subscribe(`${p}/+/$name`,                        { qos: 0 });
      this.mqttClient.subscribe(`${p}/+/MapData/segments`,             { qos: 0 });
      this.mqttClient.subscribe(`${p}/+/StatusStateAttribute/status`,  { qos: 0 });
      this.mqttClient.subscribe(`${p}/+/StatusStateAttribute/flag`,    { qos: 0 });
      // NOTE: do NOT subscribe to MapSegmentationCapability/clean —
      //       it has no getter in NoCloud; the topic is write-only.
    });

    this.mqttClient.on('message', (topic, buf) => {
      this._handleMessage(topic, buf.toString().trim());
    });

    this.mqttClient.on('error',     (e) => this.log.error(`[NoCloud] MQTT error: ${e.message}`));
    this.mqttClient.on('reconnect', ()  => this.log.warn('[NoCloud] MQTT reconnecting…'));
    this.mqttClient.on('offline',   ()  => this.log.warn('[NoCloud] MQTT broker offline'));
  }

  get prefix() {
    return (this.config.topicPrefix || 'NoCloud').replace(/\/$/, '');
  }

  // ─── Message routing ───────────────────────────────────────────────────────

  _handleMessage(topic, payload) {
    const p     = this.prefix;
    const parts = topic.split('/');

    if (parts[0] !== p || parts.length < 3) return;

    const deviceId = parts[1];
    const rest     = parts.slice(2).join('/');

    switch (rest) {
      case '$name':
        this._onRobotName(deviceId, payload);
        break;
      case 'MapData/segments':
        this._onSegments(deviceId, payload);
        break;
      case 'StatusStateAttribute/status':
        this._onStatus(deviceId, payload);
        break;
      case 'StatusStateAttribute/flag':
        this._onFlag(deviceId, payload);
        break;
    }
  }

  // ─── Discovery ─────────────────────────────────────────────────────────────

  _onRobotName(deviceId, name) {
    if (!name) return;

    if (!this.robots.has(deviceId)) {
      this.log.info(`[NoCloud] Discovered robot "${name}" [${deviceId}]`);
      this.robots.set(deviceId, this._newRobotState(name));

      // Flush any segments that arrived before the name
      if (this._pendingSegments.has(deviceId)) {
        const segs = this._pendingSegments.get(deviceId);
        this._pendingSegments.delete(deviceId);
        this._syncAccessories(deviceId, segs);
      }
    } else {
      const robot = this.robots.get(deviceId);
      if (robot.name !== name) {
        this.log.info(`[NoCloud] Robot ${deviceId} renamed "${robot.name}" → "${name}"`);
        robot.name = name;
      }
    }
  }

  _onSegments(deviceId, payload) {
    let segments;
    try {
      segments = JSON.parse(payload);
    } catch (e) {
      this.log.error(`[NoCloud] Cannot parse segments for ${deviceId}: ${e.message}`);
      return;
    }

    // IMPORTANT: NoCloud publishes {} when the map is not yet loaded.
    // Ignore empty maps to avoid removing valid cached accessories on boot.
    if (typeof segments !== 'object' || segments === null || Object.keys(segments).length === 0) {
      this.log.debug(`[NoCloud] Ignoring empty segment map for ${deviceId} (map not yet loaded)`);
      return;
    }

    if (!this.robots.has(deviceId)) {
      // Robot name not received yet — queue and wait
      this.log.debug(`[NoCloud] Segments arrived before $name for ${deviceId}, queuing`);
      this._pendingSegments.set(deviceId, segments);
      return;
    }

    this._syncAccessories(deviceId, segments);
  }

  // ─── Status tracking ───────────────────────────────────────────────────────

  _onStatus(deviceId, status) {
    const robot = this.robots.get(deviceId);
    if (!robot) return;

    const prev   = robot.status;
    robot.status = status;

    if (prev !== status) this.log.debug(`[NoCloud] ${deviceId} status: ${prev} → ${status}`);

    // When robot leaves an active cleaning state, clear the tracked segment
    if (!['cleaning', 'paused'].includes(status)) {
      robot.activeSegment = null;
    }

    this._updateSwitchStates(deviceId);
  }

  _onFlag(deviceId, flag) {
    const robot = this.robots.get(deviceId);
    if (!robot) return;

    const prev = robot.flag;
    robot.flag = flag;

    if (prev !== flag) this.log.debug(`[NoCloud] ${deviceId} flag: ${prev} → ${flag}`);

    // If no longer a segment operation, clear the active segment
    if (flag !== 'segment') {
      robot.activeSegment = null;
    }

    this._updateSwitchStates(deviceId);
  }

  /**
   * Pushes the correct On/Off state to every room switch for a robot.
   *
   * A switch is ON when the robot is cleaning (or paused mid-clean) that specific segment.
   * Showing ON when paused lets the user cancel a paused job by tapping OFF.
   */
  _updateSwitchStates(deviceId) {
    const robot = this.robots.get(deviceId);
    if (!robot) return;

    const isSegmentJob = ['cleaning', 'paused'].includes(robot.status) && robot.flag === 'segment';

    for (const [segId, roomAcc] of robot.roomAccessories) {
      roomAcc.updateState(isSegmentJob && robot.activeSegment === segId);
    }
  }

  // ─── Accessory lifecycle ───────────────────────────────────────────────────

  _syncAccessories(deviceId, segments) {
    const robot = this.robots.get(deviceId);
    if (!robot) return;

    // Only named segments are "known" — unnamed ones should be treated as non-existent
    const knownSegIds = new Set(
      Object.entries(segments)
        .filter(([id, name]) => String(name) !== String(id))
        .map(([id]) => id)
    );

    // Add new / adopt cached accessories
    for (const [segId, segName] of Object.entries(segments)) {
      // Skip segments with no custom name — NoCloud publishes id as name when unnamed
      if (String(segName) === String(segId)) {
        this.log.debug(`[NoCloud] Skipping unnamed segment ${segId} on ${deviceId}`);
        continue;
      }
      if (robot.roomAccessories.has(segId)) {
        // Already set up — just keep the name fresh
        robot.roomAccessories.get(segId).updateDisplayName(`${robot.name} – ${segName}`);
        continue;
      }

      const uuid        = this.api.hap.uuid.generate(`${PLUGIN_NAME}::${deviceId}::${segId}`);
      const displayName = `${robot.name} – ${segName}`;
      let platformAcc;

      if (this.cachedAccessories.has(uuid)) {
        platformAcc = this.cachedAccessories.get(uuid);
        platformAcc.context = { deviceId, segId, segmentName: segName, robotName: robot.name };
        this.cachedAccessories.delete(uuid); // mark adopted
        this.log.info(`[NoCloud] Adopted cached accessory: ${displayName}`);
      } else {
        platformAcc = new this.api.platformAccessory(displayName, uuid);
        platformAcc.context = { deviceId, segId, segmentName: segName, robotName: robot.name };
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAcc]);
        this.log.info(`[NoCloud] Registered new accessory: ${displayName}`);
      }

      robot.roomAccessories.set(segId, new RoomAccessory(this, platformAcc));
    }

    // Remove stale accessories for segments that no longer exist in the map
    for (const [segId, roomAcc] of robot.roomAccessories) {
      if (!knownSegIds.has(segId)) {
        this.log.info(`[NoCloud] Removing stale accessory: ${roomAcc.accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [roomAcc.accessory]);
        robot.roomAccessories.delete(segId);
      }
    }

    // Also prune orphaned cached accessories belonging to this robot
    for (const [uuid, acc] of this.cachedAccessories) {
      if (acc.context && acc.context.deviceId === deviceId && !knownSegIds.has(acc.context.segId)) {
        this.log.info(`[NoCloud] Removing orphaned cached accessory: ${acc.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.cachedAccessories.delete(uuid);
      }
    }
  }

  // ─── MQTT command helpers ──────────────────────────────────────────────────

  /**
   * Sends a segment cleaning command.
   * Payload format confirmed from NoCloud source:
   *   segment_ids: array of strings (firmware coerces with `${id}`)
   *   iterations:  number (optional, default 1)
   *   customOrder: boolean (optional, not supported by all firmware)
   */
  async startSegmentCleaning(deviceId, segId) {
    if (!this._assertConnected()) throw new Error('MQTT not connected');

    const topic   = `${this.prefix}/${deviceId}/MapSegmentationCapability/clean/set`;
    const payload = JSON.stringify({
      segment_ids: [String(segId)],
      iterations:  this.config.cleaningIterations ?? 1,
      customOrder: this.config.customOrder        ?? false,
    });

    await this._publish(topic, payload);

    const robot = this.robots.get(deviceId);
    if (robot) robot.activeSegment = String(segId);

    this.log.info(`[NoCloud] ▶ Cleaning segment "${segId}" on ${deviceId}`);
  }

  /**
   * Sends the HOME command.
   * BasicControlCapability/operation/set accepts a plain uppercase string — NOT JSON.
   * Confirmed from Commands.js: BASIC_CONTROL.HOME = "HOME"
   */
  async returnHome(deviceId) {
    if (!this._assertConnected()) throw new Error('MQTT not connected');

    const topic = `${this.prefix}/${deviceId}/BasicControlCapability/operation/set`;
    await this._publish(topic, 'HOME');

    const robot = this.robots.get(deviceId);
    if (robot) robot.activeSegment = null;

    this.log.info(`[NoCloud] 🏠 HOME sent to ${deviceId}`);
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  _assertConnected() {
    if (this.mqttClient?.connected) return true;
    this.log.error('[NoCloud] MQTT not connected — cannot publish command');
    return false;
  }

  _publish(topic, payload) {
    return new Promise((resolve, reject) => {
      this.mqttClient.publish(topic, payload, { qos: 1, retain: false }, (err) => {
        if (err) reject(err);
        else     resolve();
      });
    });
  }

  _newRobotState(name) {
    return {
      name,
      status:         'idle',     // latest StatusStateAttribute/status value
      flag:           'none',     // latest StatusStateAttribute/flag value
      activeSegment:  null,       // segId string we last commanded (optimistic tracking)
      roomAccessories: new Map(), // segId → RoomAccessory
    };
  }
}

module.exports = { NoCloudVacuumPlatform, PLATFORM_NAME, PLUGIN_NAME };
