# homebridge-nocloud-vacuum

A Homebridge platform plugin that auto-discovers all **Dreame robots running NoCloud (Valetudo)** firmware via MQTT and exposes a **Fan accessory per room per robot** in HomeKit.

| Action | HomeKit |
|---|---|
| Tap Fan **ON** | Robot starts cleaning that specific room |
| Tap Fan **OFF** | Robot returns to the dock (`HOME`) |

The plugin discovers robots and their room maps automatically — no manual configuration of device IDs or room IDs needed.

---

## Prerequisites

- Homebridge ≥ 1.6
- Node.js ≥ 18
- An MQTT broker reachable from your Homebridge host
- Dreame robots with [NoCloud](https://valetudo.cloud) firmware, configured to publish to that MQTT broker

---

## Installation

```bash
npm install -g homebridge-nocloud-vacuum
```

Or via the Homebridge UI: search for `homebridge-nocloud-vacuum`.

---

## Configuration

Add a platform block to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "NoCloudVacuumPlatform",
      "name": "NoCloud Vacuum",
      "mqttUrl": "mqtt://192.168.1.100:1883",
      "mqttUsername": "",
      "mqttPassword": "",
      "topicPrefix": "NoCloud",
      "cleaningIterations": 1,
      "customOrder": false
    }
  ]
}
```

### Options

| Key | Type | Default | Description |
|---|---|---|---|
| `mqttUrl` | string | **required** | MQTT broker URL, e.g. `mqtt://192.168.1.100:1883` or `mqtts://broker:8883` |
| `mqttUsername` | string | — | Optional MQTT username |
| `mqttPassword` | string | — | Optional MQTT password |
| `topicPrefix` | string | `NoCloud` | Must match the prefix set in each robot's NoCloud MQTT settings |
| `cleaningIterations` | integer | `1` | Cleaning passes per room (1–3) |
| `customOrder` | boolean | `false` | Pass `customOrder` flag in the clean payload (not supported by all firmware) |

---

## How it works

### Discovery

On startup the plugin subscribes to wildcard MQTT topics:

```
NoCloud/+/$name                           ← robot display name (retained)
NoCloud/+/MapData/segments                ← room segment map  (retained)
NoCloud/+/MapSegmentationCapability/clean ← last clean command (retained, for state recovery)
NoCloud/+/StatusStateAttribute/status     ← robot status
NoCloud/+/StatusStateAttribute/flag       ← operation flag
```

Retained messages arrive immediately so accessories are registered within seconds of Homebridge starting.

### MQTT topics used per robot

| Direction | Topic | Payload |
|---|---|---|
| Read | `NoCloud/{id}/$name` | Plain string, e.g. `Robot-Mansarda` |
| Read | `NoCloud/{id}/MapData/segments` | JSON: `{"2":"Baie","3":"Scari",…}` |
| Read | `NoCloud/{id}/StatusStateAttribute/status` | enum: `cleaning`, `docked`, `idle`, `returning`, … |
| Read | `NoCloud/{id}/StatusStateAttribute/flag` | enum: `none`, `segment`, `zone`, `spot`, … |
| **Write** | `NoCloud/{id}/MapSegmentationCapability/clean/set` | `{"segment_ids":["2"],"iterations":1,"customOrder":false}` |
| **Write** | `NoCloud/{id}/BasicControlCapability/operation/set` | `HOME` |

### State logic

```
status=cleaning  AND  flag=segment  AND  activeSegment=<this room>  →  Switch ON
anything else                                                        →  Switch OFF
```

### Example: your setup

Given `NoCloud/GreedyPlayfulChicken/MapData/segments`:
```json
{"1":"Bathroom","2":"Bedroom","3":"Office"}
```

And robot name `Robot-NoCloudTest`, the plugin registers these switches in HomeKit:

- Robot-NoCloudTest – Bathroom
- Robot-NoCloudTest – Bedroom
- Robot-NoCloudTest – Office

Multiple robots are fully supported — each gets its own set of room fans.

---


## Troubleshooting

### Accessories not appearing

1. Check that your robot's NoCloud MQTT prefix matches `topicPrefix` in config
2. Use `mosquitto_sub -h <broker> -t 'NoCloud/#' -v` to verify retained messages
3. Enable Homebridge debug logging: set `"debug": true` in `config.json`

### Switch turns ON but robot doesn't move

- Verify `MapSegmentationCapability` is enabled in NoCloud → Settings → Capabilities
- Check the exact segment IDs with: `mosquitto_sub -h <broker> -t 'NoCloud/+/MapData/segments' -v`

### Switch state doesn't update when robot finishes

The plugin tracks state via `StatusStateAttribute/status` + `flag`. If your
firmware publishes these topics with different values, adjust the condition in
`platform.js → _updateSwitchStates()`.

---

## License

MIT
