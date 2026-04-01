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
    this.cachedAccessories = new Map();
    this.robots = new Map();
    this.mqttClient = null;
    this._pendingSegments = new Map(); // deviceId → parsed segments object

    if (!this.config.mqttUrl) {
      this.log.error('[NoCloud] No mqttUrl configured — plugin will not start.');
      return;
    }

    this.api.on('didFinishLaunching', () => this.connectMqtt());
    this.api.on('shutdown',           () => { if (this.mqttClient) this.mqttClient.end(true); });
  }

  configureAccessory(accessory) {
    this.log.debug(`[NoCloud] Cache restore: ${accessory.displayName}`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

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

      this.mqttClient.subscribe(`${p}/+/$name`,                        { qos: 0 });
      this.mqttClient.subscribe(`${p}/+/MapData/segments`,             { qos: 0 });
      this.mqttClient.subscribe(`${p}/+/StatusStateAttribute/status`,  { qos: 0 });
      this.mqttClient.subscribe(`${p}/+/StatusStateAttribute/flag`,    { qos: 0 });
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

  _onRobotName(deviceId, name) {
    if (!name) return;

    if (!this.robots.has(deviceId)) {
      this.log.info(`[NoCloud] Discovered robot "${name}" [${deviceId}]`);
      this.robots.set(deviceId, this._newRobotState(name));

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

    if (typeof segments !== 'object' || segments === null || Object.keys(segments).length === 0) {
      this.log.debug(`[NoCloud] Ignoring empty segment map for ${deviceId} (map not yet loaded)`);
      return;
    }

    if (!this.robots.has(deviceId)) {
      this.log.debug(`[NoCloud] Segments arrived before $name for ${deviceId}, queuing`);
      this._pendingSegments.set(deviceId, segments);
      return;
    }

    this._syncAccessories(deviceId, segments);
  }

  _onStatus(deviceId, status) {
    const robot = this.robots.get(deviceId);
    if (!robot) return;

    const prev   = robot.status;
    robot.status = status;

    if (prev !== status) this.log.debug(`[NoCloud] ${deviceId} status: ${prev} → ${status}`);

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

    if (flag !== 'segment') {
      robot.activeSegment = null;
    }

    this._updateSwitchStates(deviceId);
  }

  _updateSwitchStates(deviceId) {
    const robot = this.robots.get(deviceId);
    if (!robot) return;

    const isSegmentJob = ['cleaning', 'paused'].includes(robot.status) && robot.flag === 'segment';

    for (const [segId, roomAcc] of robot.roomAccessories) {
      roomAcc.updateState(isSegmentJob && robot.activeSegment === segId);
    }
  }

  _syncAccessories(deviceId, segments) {
    const robot = this.robots.get(deviceId);
    if (!robot) return;

    const knownSegIds = new Set(
      Object.entries(segments)
        .filter(([id, name]) => String(name) !== String(id))
        .map(([id]) => id)
    );

    for (const [segId, segName] of Object.entries(segments)) {
      if (String(segName) === String(segId)) {
        this.log.debug(`[NoCloud] Skipping unnamed segment ${segId} on ${deviceId}`);
        continue;
      }
      if (robot.roomAccessories.has(segId)) {
        robot.roomAccessories.get(segId).updateDisplayName(`${robot.name} – ${segName}`);
        continue;
      }

      const uuid        = this.api.hap.uuid.generate(`${PLUGIN_NAME}::${deviceId}::${segId}`);
      const displayName = `${robot.name} – ${segName}`;
      let platformAcc;

      if (this.cachedAccessories.has(uuid)) {
        platformAcc = this.cachedAccessories.get(uuid);
        platformAcc.context = { deviceId, segId, segmentName: segName, robotName: robot.name };
        this.cachedAccessories.delete(uuid);
        this.log.info(`[NoCloud] Adopted cached accessory: ${displayName}`);
      } else {
        platformAcc = new this.api.platformAccessory(displayName, uuid);
        platformAcc.context = { deviceId, segId, segmentName: segName, robotName: robot.name };
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAcc]);
        this.log.info(`[NoCloud] Registered new accessory: ${displayName}`);
      }

      robot.roomAccessories.set(segId, new RoomAccessory(this, platformAcc));
    }

    for (const [segId, roomAcc] of robot.roomAccessories) {
      if (!knownSegIds.has(segId)) {
        this.log.info(`[NoCloud] Removing stale accessory: ${roomAcc.accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [roomAcc.accessory]);
        robot.roomAccessories.delete(segId);
      }
    }

    for (const [uuid, acc] of this.cachedAccessories) {
      if (acc.context && acc.context.deviceId === deviceId && !knownSegIds.has(acc.context.segId)) {
        this.log.info(`[NoCloud] Removing orphaned cached accessory: ${acc.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.cachedAccessories.delete(uuid);
      }
    }
  }

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

  async returnHome(deviceId) {
    if (!this._assertConnected()) throw new Error('MQTT not connected');

    const topic = `${this.prefix}/${deviceId}/BasicControlCapability/operation/set`;
    await this._publish(topic, 'HOME');

    const robot = this.robots.get(deviceId);
    if (robot) robot.activeSegment = null;

    this.log.info(`[NoCloud] HOME sent to ${deviceId}`);
  }

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
      status:         'idle',
      flag:           'none',
      activeSegment:  null,
      roomAccessories: new Map(),
    };
  }
}

module.exports = { NoCloudVacuumPlatform, PLATFORM_NAME, PLUGIN_NAME };
