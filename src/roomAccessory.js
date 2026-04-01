'use strict';

/**
 * RoomAccessory
 *
 * Wraps a Homebridge PlatformAccessory and exposes a HomeKit Switch service.
 *
 * Accessory Type Rationale
 * ────────────────────────
 * A Switch (Service.Switch) is the best HomeKit fit here:
 *   ON  → "clean this room"
 *   OFF → "return to dock"
 *
 * A Fan accessory (as commonly used for Valetudo) works but carries confusing
 * semantics — "fan speed" has no meaning on a vacuum. Switch is cleaner and
 * behaves better in Shortcuts and Automations (binary trigger, no speed UI).
 *
 * If you still prefer Fan, swap Service.Switch → Service.Fan and
 * Characteristic.On → Characteristic.On (same characteristic name in HAP).
 * The rest of the logic is identical.
 */
class RoomAccessory {

  /**
   * @param {import('./platform').NoCloudVacuumPlatform} platform
   * @param {PlatformAccessory} accessory
   */
  constructor(platform, accessory) {
    this.platform  = platform;
    this.accessory = accessory;
    this.hap       = platform.api.hap;

    const { deviceId, segId, segmentName, robotName } = accessory.context;
    this.deviceId    = deviceId;
    this.segId       = segId;
    this.segmentName = segmentName;
    this.robotName   = robotName;

    this._setupInformationService();
    this._setupSwitchService();
  }
  updateDisplayName(newName) {
    if (this.accessory.displayName !== newName) {
      this.accessory.displayName = newName;
      this.switchService.setCharacteristic(this.platform.api.hap.Characteristic.Name, this.segmentName);
    }
  }
  // ─── Service setup ─────────────────────────────────────────────────────────

  _setupInformationService() {
    const svc = this.accessory.getService(this.hap.Service.AccessoryInformation)
             || this.accessory.addService(this.hap.Service.AccessoryInformation);

    svc
      .setCharacteristic(this.hap.Characteristic.Manufacturer,    'Dreame / NoCloud')
      .setCharacteristic(this.hap.Characteristic.Model,           'Robot Vacuum — Room Switch')
      .setCharacteristic(this.hap.Characteristic.SerialNumber,    `${this.deviceId}-seg${this.segId}`)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, '1.0.0');
  }

  _setupSwitchService() {
    // Reuse existing service from cache, or add a fresh one
    this.switchService = this.accessory.getService(this.hap.Service.Fan)
                      || this.accessory.addService(this.hap.Service.Fan, this.segmentName);

    // Keep the sub-type name in sync with the current segment name
    this.switchService.setCharacteristic(this.hap.Characteristic.Name, this.segmentName);

    this.switchService
      .getCharacteristic(this.hap.Characteristic.On)
      .onGet(this._handleGet.bind(this))
      .onSet(this._handleSet.bind(this));
  }

  // ─── HomeKit handlers ──────────────────────────────────────────────────────

  _handleGet() {
    const robot = this.platform.robots.get(this.deviceId);
    if (!robot) return false;

    const isCleaning = robot.status === 'cleaning' && robot.flag === 'segment';
    const isThisRoom = robot.activeSegment === String(this.segId);

    return isCleaning && isThisRoom;
  }

  async _handleSet(value) {
    if (value) {
      // Switch turned ON → start cleaning this room
      await this.platform.startSegmentCleaning(this.deviceId, this.segId)
        .catch((err) => {
          this.platform.log.error(
            `[NoCloud] Failed to start cleaning ${this.deviceId}/${this.segId}: ${err.message}`,
          );
          // Revert the optimistic ON state
          setTimeout(() => {
            this.switchService.updateCharacteristic(this.hap.Characteristic.On, false);
          }, 500);
        });
    } else {
      // Switch turned OFF → return robot to dock
      await this.platform.returnHome(this.deviceId)
        .catch((err) => {
          this.platform.log.error(
            `[NoCloud] Failed to send HOME for ${this.deviceId}: ${err.message}`,
          );
        });
    }
  }

  // ─── State push from platform ──────────────────────────────────────────────

  /**
   * Called by the platform whenever the robot's status/flag changes.
   * Pushes the new On/Off state to HomeKit without a HAP round-trip.
   *
   * @param {boolean} isActive  true if this specific room is being cleaned right now
   */
  updateState(isActive) {
    this.switchService.updateCharacteristic(this.hap.Characteristic.On, isActive);
  }
}

module.exports = { RoomAccessory };
