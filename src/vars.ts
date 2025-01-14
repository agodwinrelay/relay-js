import { URL } from 'url'

const config = {
  qa: {
    host: `all-api-qa-ibot.nocell.io`,
    authHost: `auth.relaygo.info`,
    client_id: `rGGK996c`,
  },
  pro: {
    host: `all-main-pro-ibot.nocell.io`,
    authHost: `auth.relaygo.com`,
    client_id: `TgDsXRuD`,
  }
}

/**
 * Utility class to resolve environment variables
 * @internal
 */
export class Vars {
  get env(): `qa`|`pro` {
    if (process.env.RELAY_ENV) {
      if (process.env.RELAY_ENV !== `qa` && process.env.RELAY_ENV !== `pro`) {
        throw new Error(`RELAY_ENV must be set to either "qa" or "pro"`)
      } else {
        return process.env.RELAY_ENV
      }
    } else {
      return `qa`
    }
  }

  get host(): string {
    const h = process.env.RELAY_HOST || config[this.env].host
    if (!h.includes(this.env)) {
      process.env.RELAY_ENV && console.error(`RELAY_ENV=${process.env.RELAY_ENV}`)
      process.env.RELAY_HOST && console.error(`RELAY_HOST=${process.env.RELAY_HOST}`)
      console.error(`Host and environment must align`)
      throw new Error(`Environment / host mismatch`)
    } else {
      return h
    }

  }

  get apiUrl(): string {
    return this.host.startsWith(`http`) ? this.host : `https://${this.host}`
  }

  get apiHost(): string {
    if (this.host.startsWith(`http`)) {
      const u = new URL(this.host)
      if (u.host) return u.host
    }
    return `${this.host}`
  }

  get authHost(): string {
    return config[this.env].authHost
  }

  get authUrl(): string {
    return `https://${this.authHost}`
  }

  get authId(): string {
    return config[this.env].client_id
  }
}

export const vars = new Vars()
