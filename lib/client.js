/*
** Module dependencies
*/
const HttpAgent = require('http').Agent
const HttpsAgent = require('https').Agent
const parseUrl = require('url').parse // eslint-disable-line node/no-deprecated-api
const got = require('got')
const {findLast} = require('lodash')
const semver = require('semver')
const debug = require('debug')('wfs')
const pkg = require('../package.json')
const xml = require('./xml')

const defaultUserAgent = `wfs-client/${pkg.version} (+https://github.com/geodatagouv/wfs-client)`

/*
** Config
*/
const Agent = {
  'http:': HttpAgent,
  'https:': HttpsAgent
}

const supportedVersions = {
  '1.0.0': require('./versions/1.0.0'),
  '1.1.0': require('./versions/1.1.0'),
  '2.0.0': require('./versions/2.0.0')
}
const supportedVersionsKeys = Object.keys(supportedVersions)

class Client {
  constructor(url, options = {}) {
    if (!url) {
      throw new TypeError('URL is required!')
    }

    this.url = url
    this.queryStringToAppend = options.queryStringToAppend || {}

    if (options.version) {
      if (!(options.version in supportedVersions)) {
        throw new Error('Version not supported by client')
      }

      this.version = options.version
    }

    this.options = {
      userAgent: options.userAgent,
      timeout: options.timeout
    }

    if (options.maxSockets || options.keepAlive) {
      const {protocol} = parseUrl(url)
      const {maxSockets, keepAlive} = options

      this.agent = new Agent[protocol]({
        maxSockets,
        keepAlive
      })
    }
  }

  async _ensureVersion() {
    if (!this.version) {
      this.version = await this._negociateVersion(supportedVersionsKeys[supportedVersionsKeys.length - 1])
    }

    return this.version
  }

  async _negociateVersion(candidateVersion) {
    debug('client is trying with version %s', candidateVersion)

    const capabilities = await this._request({request: 'GetCapabilities', version: candidateVersion})
    if (capabilities.root().name() === 'WFS_Capabilities') {
      const rootNode = capabilities.root()
      const detectedVersion = rootNode.attr('version') ? rootNode.attr('version').value() : null
      if (!detectedVersion || !semver.valid(detectedVersion)) {
        debug('unable to read version in Capabilities')
        throw new Error('Unable to read version in Capabilities')
      }

      debug('server responded with version %s', detectedVersion)
      if (detectedVersion === candidateVersion) {
        debug('client and server versions are matching!')
        return detectedVersion
      }

      if (semver.gt(detectedVersion, candidateVersion)) {
        debug('client candidate version (%s) is smaller than the lowest supported by server (%s)', candidateVersion, detectedVersion)
        debug('version negociation failed')
        throw new Error('Version negociation has failed. Lowest version supported by server is ' + detectedVersion + ' but candidateVersion was ' + candidateVersion)
      } else {
        debug('candidate version (%s) is greater than server one (%s)', candidateVersion, detectedVersion)
        if (detectedVersion in supportedVersions) {
          debug('version returned by server (%s) is supported by client', detectedVersion)
          return detectedVersion
        }

        const nextCandidateVersion = findLast(supportedVersionsKeys, supportedVersion => {
          return semver.lt(supportedVersion, detectedVersion)
        })
        debug('nearest smaller version supported by client is %s', nextCandidateVersion)
        return this._negociateVersion(nextCandidateVersion)
      }
    }

    debug('enter in recovery mode (unable to read capabilities)')
    const nextCandidateVersion = findLast(supportedVersionsKeys, supportedVersion => {
      return semver.lt(supportedVersion, candidateVersion)
    })
    if (nextCandidateVersion) {
      debug('nearest smaller version supported by client is %s', nextCandidateVersion)
      return this._negociateVersion(nextCandidateVersion)
    }

    debug('version negocation failed - recovery mode')
    throw new Error('Version negociation has failed (recovery mode)')
  }

  async _request(query) {
    const options = {
      encoding: null,
      query: {
        service: 'WFS',
        ...this.queryStringToAppend,
        ...query
      },
      headers: {
        'user-agent': this.options.userAgent || defaultUserAgent
      },
      agent: this.agent
    }

    if (this.options.timeout) {
      options.timeout = this.options.timeout * 1000
    }

    const {body} = await got(this.url, options)

    return xml.parse(body)
  }

  async capabilities() {
    const client = this

    const version = await client._ensureVersion()
    const xmlDoc = await client._request({request: 'GetCapabilities', version})

    return supportedVersions[version].parseCapabilities(xmlDoc)
  }

  async featureTypes() {
    const capabilities = await this.capabilities()

    return capabilities.featureTypes || []
  }
}

/*
** Exports
*/
module.exports = Client
