import WebSocket from 'ws'
import events from 'events'

import * as enums from './enums'

import { safeParse, noop, makeId } from './utils'

import { PORT, HEARTBEAT, STRICT_PATH, TIMEOUT, REFRESH_TIMEOUT } from './constants'
import { LedIndex, BaseCall, ButtonEvent, Call, ConnectedCall, DisconnectedCall, FailedCall, LocalWebSocket, NotificationEvent, Options, ReceivedCall, Relay, StartedCall, Workflow } from './types'

const {
  Event,
  Language,
  DeviceInfoQuery,
  DeviceInfoField,
  Notification,
} = enums

export * from './enums'

interface WorkflowEvents {
  [Event.START]: (event: Record<string, never>) => void,
  [Event.BUTTON]: (event: ButtonEvent) => void,
  [Event.TIMER]: (event: Record<string, never>) => void,
  [Event.NOTIFICATION]: (event: NotificationEvent) => void,
  [Event.CALL_CONNECTED]: (event: ConnectedCall) => void,
  [Event.CALL_DISCONNECTED]: (event: DisconnectedCall) => void,
  [Event.CALL_FAILED]: (event: FailedCall) => void,
  [Event.CALL_RECEIVED]: (event: ReceivedCall) => void,
  [Event.CALL_START_REQUEST]: (event: StartedCall) => void,
}

const createWorkflow = (fn: Workflow): Workflow => fn

const WORKFLOW_EVENT_REGEX = /^wf_api_([a-z]*)_event$/

class RelayEventAdapter {
  private websocket: WebSocket | null = null
  private emitter: events.EventEmitter | null = null

  constructor(websocket: WebSocket) {
    console.log(`creating event adapter`)
    this.emitter = new events.EventEmitter()
    this.websocket = websocket
    this.websocket.on(`close`, this.onClose.bind(this))
    this.websocket.on(`message`, this.onMessage.bind(this))
  }

  on<U extends keyof WorkflowEvents>(event: U, listener: WorkflowEvents[U]): void {
    this.emitter?.on(event, listener)
  }

  off<U extends keyof WorkflowEvents>(event: U, listener: WorkflowEvents[U]): void {
    this.emitter?.off(event, listener)
  }

  private async onClose(): Promise<void> {
    this.websocket = null
  }

  private onMessage(msg: string): void {
    const message = safeParse(msg)
    if (this.emitter && message?._type && !message?._id) { // not interested in response events (marked by correlation id)
      const eventNameParts = message._type.match(WORKFLOW_EVENT_REGEX)
      if (eventNameParts?.[1]) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _type, ...args } = message
        this.emitter.emit(eventNameParts?.[1], args)
      } else {
        console.log(`Unknown message =>`, message)
      }
    }
  }

  /*
  private async stop(): Promise<void> {
    console.log(`stopping event adapter`)
    if (this.websocket) {
      console.log(`terminating event adapter websocket`)
      this.websocket.terminate()
    }
  }
  */

  private async _send(type: string, payload={}, id?: string): Promise<void|Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.websocket) {
        reject(`websocket-not-connected`)
        return
      }

      const message = {
        _id: id ?? makeId(),
        _type: `wf_api_${type}_request`,
        ...payload,
      }

      const messageStr = JSON.stringify(message)

      this.websocket.send(messageStr, (err) => {
        if (err) {
          reject(`failed-to-send`)
        } else {
          resolve()
        }
      })
    })
  }

  private async _sendReceive(type: string, payload={}, timeout=TIMEOUT): Promise<void|Record<string, unknown>> {
    const id = makeId()

    await this._send(type, payload, id)

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.websocket?.off?.(`message`, responseListener)
        reject(`failed-to-receive-response-timeout`)
      }, timeout)

      const responseListener = (msg: string) => {
        clearTimeout(timeoutHandle)
        const event = safeParse(msg)
        if (event) {
          const { _id, _type, ...params } = event
          if (_id === id) { // interested here in response events (marked by correlation id)
            // stop listening as soon as we have a correlated response
            this.websocket?.off(`message`, responseListener)
            if (_type === `wf_api_${type}_response`) {
              resolve(Object.keys(params).length > 0 ? params as Record<string, unknown> : undefined)
            } else if (_type === `wf_api_error_response`) {
              reject(event?.error)
            } else {
              console.log(`Unknown response`, event)
              reject(new Error(`Unknown response`))
            }
          }
        }
      }
      // start listening to websocket messages for correlated response
      this.websocket?.on(`message`, responseListener)
    })
  }

  private async _cast(type: string, payload={}, timeout=TIMEOUT): Promise<void> {
    await this._sendReceive(type, payload, timeout)
  }

  private async _call(type: string, payload={}, timeout=TIMEOUT): Promise<Record<string, unknown>> {
    return (await this._sendReceive(type, payload, timeout)) as Record<string, unknown>
  }

  async say(text: string, lang=Language.ENGLISH): Promise<void> {
    await this._cast(`say`, { text, lang })
  }

  async play(filename: string): Promise<void> {
    await this._cast(`play`, { filename })
  }

  async translate(text: string, from=Language.ENGLISH, to=Language.SPANISH): Promise<string> {
    const { text: translatedText } = (await this._call(`translate`, { text, from_lang: from, to_lang: to})) as Record<`text`, string>
    return translatedText
  }

  async vibrate(pattern: number[]): Promise<void> {
    await this._cast(`vibrate`, { pattern })
  }

  async switchLedOn(led: LedIndex, color: string): Promise<void> {
    await this._cast(`set_led`, { effect: `static`, args: { colors: { [`${led}`]: color } } })
  }

  async switchAllLedOn(color: string): Promise<void> {
    await this._cast(`set_led`, { effect: `static`, args: { colors: { ring: color } } })
  }

  async switchAllLedOff(): Promise<void> {
    await this._cast(`set_led`, { effect: `off`, args: {} })
  }

  async rainbow(rotations=-1): Promise<void> {
    await this._cast(`set_led`, { effect: `rainbow`, args: { rotations } })
  }

  async rotate(): Promise<void> {
    await this._cast(`set_led`, { effect: `rotate`, args: { rotations: -1, colors: { [`1`]: `FFFFFF` } } })
  }

  async flash(): Promise<void> {
    await this._cast(`set_led`, { effect: `flash`, args: { count: -1, colors: { ring: `0000FF` } } })
  }

  async breathe(): Promise<void> {
    await this._cast(`set_led`, { effect: `breathe`, args: { count: -1, colors: { ring: `0000FF` } } })
  }

  private async _getDeviceInfo(query: enums.DeviceInfoQuery, refresh=false) {
    const response = await this._call(`get_device_info`, { query, refresh }, refresh ? REFRESH_TIMEOUT : TIMEOUT)  as Record<string, string|number|number[]>
    return response[query]
  }

  async getDeviceName(): Promise<string> {
    return await this._getDeviceInfo(DeviceInfoQuery.NAME) as string
  }

  async getDeviceLocation(refresh: boolean): Promise<string> {
    return await this._getDeviceInfo(DeviceInfoQuery.ADDRESS, refresh) as string
  }

  async getDeviceId(): Promise<string> {
    return await this._getDeviceInfo(DeviceInfoQuery.ID) as string
  }

  async getDeviceAddress(refresh: boolean): Promise<string> {
    return await this.getDeviceLocation(refresh)
  }

  async getDeviceCoordinates(refresh: boolean): Promise<number[]> {
    return await this._getDeviceInfo(DeviceInfoQuery.COORDINATES, refresh) as number[]
  }

  async getDeviceLatLong(refresh: boolean): Promise<number[]> {
    return await this.getDeviceCoordinates(refresh) as number[]
  }

  async getDeviceIndoorLocation(refresh: boolean): Promise<string> {
    return await this._getDeviceInfo(DeviceInfoQuery.INDOOR_LOCATION, refresh) as string
  }

  async getDeviceBattery(refresh: boolean): Promise<number> {
    return await this._getDeviceInfo(DeviceInfoQuery.BATTERY, refresh) as number
  }

  private async setDeviceInfo(field: enums.DeviceInfoField, value: string): Promise<void> {
    await this._cast(`set_device_info`, { field, value })
  }

  async setDeviceName(name: string): Promise<void> {
    await this.setDeviceInfo(DeviceInfoField.LABEL, name)
  }

  async setDeviceChannel(channel: string): Promise<void> {
    await this.setDeviceInfo(DeviceInfoField.CHANNEL, channel)
  }

  async setChannel(name:string, target: string[]): Promise<void> {
    await this._cast(`set_channel`, { channel_name: name, target })
  }

  async placeCall(call: Call): Promise<void> {
    await this._call(`call`, call)
  }

  private _buildCallIdRequestOrThrow(arg: string|Call): BaseCall {
    if (typeof arg === `string`) {
      return { call_id: arg }
    } else if (typeof arg === `object`) {
      if (typeof arg.call_id === `string`) {
        return { call_id: arg.call_id }
      } else {
        throw new Error(`missing required parameter`)
      }
    } else {
      throw new Error(`invalid argument type`)
    }
  }

  async answerCall(callRequest: string|Call): Promise<void> {
    await this._call(`answer`, this._buildCallIdRequestOrThrow(callRequest))
  }

  async hangupCall(callRequest: string|Call): Promise<void> {
    await this._call(`hangup`, this._buildCallIdRequestOrThrow(callRequest))
  }

  async setVar(name: string, value: string): Promise<void> {
    await this._cast(`set_var`, { name, value })
  }

  async set(obj: Record<string, string>, value?: string): Promise<void> {
    if (typeof obj === `object`) {
      await Promise.all(
        Object.entries(obj)
          .map(([name, value]) => this.setVar(name, value))
      )
    } else if (value !== undefined) {
      await this.setVar(obj, value)
    }
  }

  async getVar(name: string, defaultValue=undefined): Promise<string> {
    const { value } = (await this._call(`get_var`, { name }) ?? defaultValue) as Record<`value`, string>
    return value
  }

  async get(names: string|string[]): Promise<string | string[]> {
    if (Array.isArray(names)) {
      return Promise.all(
        names.map(name => this.getVar(name))
      )
    } else {
      return this.getVar(names)
    }
  }

  async startTimer(timeout=60): Promise<void> {
    await this._cast(`start_timer`, { timeout })
  }

  async stopTimer(): Promise<void> {
    await this._cast(`stop_timer`)
  }

  private async _sendNotification(type: enums.Notification, text: undefined|string, target: string[], name?: string): Promise<void> {
    await this._cast(`notification`, { type, name, text, target })
  }

  async broadcast(text: string, target: string[]): Promise<void> {
    await this._sendNotification(Notification.BROADCAST, text, target)
  }

  async notify(text: string, target: string[]): Promise<void> {
    await this._sendNotification(Notification.NOTIFY, text, target)
  }

  async alert(name: string, text: string, target: string[]): Promise<void> {
    await this._sendNotification(Notification.ALERT, text, target, name)
  }

  async cancelAlert(name: string, target: string[]): Promise<void> {
    await this._sendNotification(Notification.CANCEL, undefined, target, name)
  }

  async listen(phrases=[], { transcribe=true, alt_lang=Language.ENGLISH, timeout=60 }={}): Promise<Record<`text`, string> | Record<`audio`, string>> {
    const response = await this._call(`listen`, { transcribe, phrases, timeout, alt_lang }, timeout * 1000)  as Record<`text`|`audio`, string>
    if (transcribe) {
      return { text: response.text } as Record<`text`, string>
    } else {
      return { audio: response.audio } as Record<`audio`, string>
    }
  }

  async createIncident(type: string): Promise<string> {
    const { incident_id } = await this._call(`create_incident`, { type })  as Record<`incident_id`, string>
    return incident_id
  }

  async resolveIncident(incidentId: string, reason: string): Promise<void> {
    await this._cast(`resolve_incident`, { incident_id: incidentId, reason })
  }

  async terminate(): Promise<void> {
    await this._send(`terminate`)
  }
}

const DEFAULT_WORKFLOW = `__default_relay_workflow__`
let workflows: Map<string, Workflow> | null = null
let instances: Map<string, RelayEventAdapter> | null = null
let server: WebSocket.Server | null = null

const initializeRelaySdk = (options: Options={}): Relay => {
  if (workflows) {
    throw new Error(`Relay SDK already initialized`)
  } else {
    workflows = new Map()
    instances = new Map()

    const serverOptions = options.server ? { server: options.server } : { port: PORT }
    server = new WebSocket.Server(serverOptions, () => {
      console.log(`Relay SDK WebSocket Server listening => ${PORT}`)
    })

    server.shouldHandle = (request) => {
      console.info(`WebSocket request =>`, request.url)
      if (request.url) {
        const shouldEnforceStrictPaths = (options.STRICT_PATH ?? STRICT_PATH) === `1`
        const path = request.url.slice(1)
        const hasDefaultWorkflow = workflows?.has(DEFAULT_WORKFLOW)
        const hasNamedWorkflow = workflows?.has(path)
        return (shouldEnforceStrictPaths ? hasNamedWorkflow : hasDefaultWorkflow) ?? false
      } else {
        return false
      }
    }

    server.on(`connection`, (websocket: LocalWebSocket, request) => {
      if (request.url && workflows) {
        const path = request.url.slice(1)
        const workflowName = workflows.has(path) ? path : DEFAULT_WORKFLOW

        const workflow = workflows.get(workflowName)

        if (workflow) {
          websocket.connectionId = `${workflowName}-${makeId()}`
          websocket.isAlive = true

          websocket.on(`pong`, () => {
            websocket.isAlive = true
          })

          websocket.on(`close`, (/*code, reason*/) => {
            console.info(`Workflow closed =>`, websocket.connectionId)
            instances?.delete(websocket.connectionId)
          })

          const adapter = new RelayEventAdapter(websocket)
          workflow(adapter)
          instances?.set(websocket.connectionId, adapter)
          console.info(`Workflow connection =>`, websocket.connectionId)
        } else {
          console.info(`Workflow not found; terminating websocket =>`, websocket.connectionId)
          websocket.terminate()
        }
      }
    })

    server.on(`error`, err => {
      console.error(err)
    })

    setInterval(() => {
      server?.clients.forEach((websocket) => {
        const _websocket = websocket as LocalWebSocket
        if (_websocket.isAlive === false) {
          return websocket.terminate()
        }
        _websocket.isAlive = false
        websocket.ping(noop)
      })
    }, HEARTBEAT)

    return {
      workflow: (path: string|Workflow, workflow: Workflow) => {
        if (workflows) {
          if ((typeof path === `function`)) {
            console.info(`Default workflow set`)
            workflows.set(DEFAULT_WORKFLOW, path)
          } else if (typeof path === `string`) {
            const strippedPath = path.replace(/^\/+/,``)
            workflows.set(strippedPath, workflow)
          } else {
            throw new Error(`First argument for workflow must either be a string or a function`)
          }
        } else {
          console.error(`workflows is not initialized`)
        }
      }
    }
  }
}

export {
  initializeRelaySdk as relay,
  createWorkflow,
}

export type { RelayEventAdapter, Event, Workflow, Relay, Language, Options }