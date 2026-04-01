'use strict';

class RoomAccessory {

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
    this.switchService = this.accessory.getService(this.hap.Service.Fan)
                      || this.accessory.addService(this.hap.Service.Fan, this.segmentName);

    this.switchService.setCharacteristic(this.hap.Characteristic.Name, this.segmentName);

    this.switchService
      .getCharacteristic(this.hap.Characteristic.On)
      .onGet(this._handleGet.bind(this))
      .onSet(this._handleSet.bind(this));
  }

  _handleGet() {
    const robot = this.platform.robots.get(this.deviceId);
    if (!robot) return false;

    const isCleaning = robot.status === 'cleaning' && robot.flag === 'segment';
    const isThisRoom = robot.activeSegment === String(this.segId);

    return isCleaning && isThisRoom;
  }

  async _handleSet(value) {
    if (value) {
      await this.platform.startSegmentCleaning(this.deviceId, this.segId)
        .catch((err) => {
          this.platform.log.error(
            `[NoCloud] Failed to start cleaning ${this.deviceId}/${this.segId}: ${err.message}`,
          );
          setTimeout(() => {
            this.switchService.updateCharacteristic(this.hap.Characteristic.On, false);
          }, 500);
        });
    } else {
      await this.platform.returnHome(this.deviceId)
        .catch((err) => {
          this.platform.log.error(
            `[NoCloud] Failed to send HOME for ${this.deviceId}: ${err.message}`,
          );
        });
    }
  }

  updateState(isActive) {
    this.switchService.updateCharacteristic(this.hap.Characteristic.On, isActive);
  }
}

module.exports = { RoomAccessory };
