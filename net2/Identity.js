/*    Copyright 2021 Firewalla Inc
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient();
const PolicyManager = require('./PolicyManager.js');
const sysManager = require('./SysManager.js');
const pm = new PolicyManager();
const f = require('./Firewalla.js');
const exec = require('child-process-promise').exec;
const { Address4, Address6 } = require('ip-address');

const Promise = require('bluebird');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const ipset = require('./Ipset.js');
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const routing = require('../extension/routing/routing.js');
const _ = require('lodash');
const fs = require('fs');
Promise.promisifyAll(fs);

const envCreatedMap = {};
const instances = {};

class Identity {
  constructor(o) {
    const instanceKey = `${this.constructor.getNamespace()}:${this.getUniqueId()}`
    this.o = o;
    if (!instances[instanceKey]) {
      this._policy = {};
      const c = require('./MessageBus.js');
      this.subscriber = new c('info');
      if (f.isMain()) {
        this.monitoring = false;
        const uid = this.getUniqueId();
        if (uid) {
          this.subscriber.subscribeOnce("DiscoveryEvent", "IdentityPolicy:Changed", uid, (channel, type, id, obj) => {
            log.info(`Identity policy is changed on ${uid}`, obj);
            this.scheduleApplyPolicy();
          })
        }
      }
      instances[instanceKey] = this;
    }
    return instances[instanceKey];
  }

  update(o) {
    this.o = o;
  }

  scheduleApplyPolicy() {
    if (this.applyPolicyTask)
      clearTimeout(this.applyPolicyTask);
    this.applyPolicyTask = setTimeout(() => {
      this.applyPolicy();
    }, 3000);
  }

  _getPolicyKey() {
    return `policy:${this.constructor.getNamespace()}:${this.getUniqueId()}`;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this._policy});
    return json;
  }

  async applyPolicy() {
    await this.loadPolicy();
    const policy = JSON.parse(JSON.stringify(this._policy));
    await pm.executeAsync(this, this.getUniqueId(), policy);
  }

  async loadPolicy() {
    const key = this._getPolicyKey();
    const policyData = await rclient.hgetallAsync(key);
    if (policyData) {
      this._policy = {};
      for (let k in policyData) {
        this._policy[k] = JSON.parse(policyData[k]);
      }
    } else {
      this._policy = {};
    }
    return this._policy;
  }

  async savePolicy() {
    const key = this._getPolicyKey();
    const policyObj = {};
    for (let k in this._policy) {
      policyObj[k] = JSON.stringify(this._policy[k]);
    }
    await rclient.hmsetAsync(key, policyObj).catch((err) => {
      log.error(`Failed to save policy to ${key}`, err);
    })
  }

  async setPolicy(name, data) {
    this._policy[name] = data;
    await this.savePolicy();
    if (this.subscriber) {
      this.subscriber.publish("DiscoveryEvent", "IdentityPolicy:Changed", this.getUniqueId(), {name, data});
    }
  }

  static getEnforcementIPsetName(uid, af = 4) {
    return `c_${this.getNamespace()}_${uid.substring(0, 12)}_set` + (af === 4 ? "" : "6");
  }

  static getEnforcementDnsmasqGroupId(uid) {
    return `${this.getNamespace()}_${uid}`;
  }

  static getRedisSetName(uid) {
    return `${this.getNamespace()}:addresses:${uid}`
  }

  static getDnsmasqConfigDirectory(uid) {
    return `${f.getUserConfigFolder()}/dnsmasq`
  }

  static getDnsmasqConfigFilenamePrefix(uid) {
    return `${this.getNamespace()}_${uid}`;
  }

  static async ensureCreateEnforcementEnv(uid) {
    const content = `redis-src-address-group=%${this.getRedisSetName(uid)}@${this.getEnforcementDnsmasqGroupId(uid)}`;
    await fs.writeFileAsync(`${this.getDnsmasqConfigDirectory(uid)}/${this.getDnsmasqConfigFilenamePrefix(uid)}.conf`, content, { encoding: 'utf8' }).catch((err) => {
      log.error(`Failed to create dnsmasq config for identity ${uid}`, err.message);
    });
    dnsmasq.scheduleRestartDNSService();
    const instanceKey = `${this.getNamespace()}:${uid}`
    if (envCreatedMap[instanceKey])
      return;
    // create related ipsets
    await exec(`sudo ipset create -! ${this.getEnforcementIPsetName(uid)} hash:net`).catch((err) => {
      log.error(`Failed to create identity ipset ${this.getEnforcementIPsetName(uid)}`, err.message);
    });
    await exec(`sudo ipset create -! ${this.getEnforcementIPsetName(uid, 6)} hash:net family inet6`).catch((err) => {
      log.error(`Failed to create identity ipset ${this.getEnforcementIPsetName(uid, 6)}`, err.message);
    });
    envCreatedMap[instanceKey] = 1;
  }

  async createEnv() {
    await this.constructor.ensureCreateEnforcementEnv(this.getUniqueId());
  }

  async destroyEnv() {
    await exec(`sudo ipset flush -! ${this.constructor.getEnforcementIPsetName(this.getUniqueId())}`).catch((err) => {
      log.error(`Failed to flush identity ipset ${this.constructor.getEnforcementIPsetName(this.getUniqueId())}`, err.message);
    });
    await exec(`sudo ipset flush -! ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)}`).catch((err) => {
      log.error(`Failed to flush identity ipset ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)}`, err.message);
    });
    // delete related dnsmasq config files
    await exec(`sudo rm -f ${this.constructor.getDnsmasqConfigDirectory(uid)}/${this.constructor.getDnsmasqConfigFilenamePrefix(uid)}.conf`).catch((err) => {});
    await exec(`sudo rm -f ${this.constructor.getDnsmasqConfigDirectory(uid)}/${this.constructor.getDnsmasqConfigFilenamePrefix(uid)}_*.conf`).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async updateIPs(ips) {
    if (this._ips && _.isEqual(ips.sort(), this._ips.sort())) {
      log.info(`IP addresses of identity ${this.getUniqueId()} is not changed`, ips);
      return;
    }
    log.info(`IP addresses of identity ${this.getUniqueId()} is changed`, this._ips, ips);
    await exec(`sudo ipset flush ${this.constructor.getEnforcementIPsetName(this.getUniqueId())}`).catch((err) => {
      log.error(`Failed to flush ${this.constructor.getEnforcementIPsetName(this.getUniqueId())}`, err.message);
    });
    await exec(`sudo ipset flush ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)}`).catch((err) => {
      log.error(`Failed to flush ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)}`, err.message);
    });
    const cmds = [];
    for (const ip of ips) {
      if (new Address4(ip).isValid()) {
        cmds.push(`add ${this.constructor.getEnforcementIPsetName(this.getUniqueId())} ${ip}`);
      } else {
        if (new Address6(ip).isValid()) {
          cmds.push(`add ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)} ${ip}`);
        }
      }
    }
    await ipset.batchOp(cmds).catch((err) => {
      log.error(`Failed to populate ipset of identity ${this.getUniqueId()}`, err.message);
    });
    // update IP addresses in redis set
    // TODO: only supports IPv4 address here
    const currentIPs = await rclient.smembersAsync(this.constructor.getRedisSetName(this.getUniqueId()));
    const removedIPs = currentIPs.filter(ip => !ips.includes(ip)) || [];
    const newIPs = ips.filter(ip => !ip.includes('/') && !currentIPs.includes(ip));
    if (removedIPs.length > 0)
      await rclient.sremAsync(this.constructor.getRedisSetName(this.getUniqueId()), removedIPs);
    if (newIPs.length > 0)
      await rclient.saddAsync(this.constructor.getRedisSetName(this.getUniqueId()), newIPs);
    this._ips = ips;
  }

  getUniqueId() {

  }

  static getKeyOfUIDInAlarm() {

  }

  // return a string, length of which should not exceed 8
  static getNamespace() {

  }

  static getKeyOfInitData() {

  }

  static async getInitData() {
    const json = {};
    const identities = await this.getIdentities();
    for (const uid of Object.keys(identities)) {
      await identities[uid].loadPolicy();
      json[uid] = identities[uid].toJson();
    }
    return json;
  }

  // return an object, key is uid, value is an Idendity object
  static async getIdentities() {
    return {};
  }

  // return an object, key is IP address, value is uid
  static async getIPUniqueIdMappings() {
    return {};
  }

  // return an object, key is IP address, value is IP:port of the endpoint. This is usually applicable on tunnelled identity
  static async getIPEndpointMappings() {
    return {};
  }

  // getIdentities will be invoked if any of these events is triggered
  static getRefreshIdentitiesHookEvents() {
    return [];
  }

  // getIPUniqueIdMappings will be invoked if any of these events is triggered
  static getRefreshIPMappingsHookEvents() {
    return [];
  }

  getReadableName() {
    return this.getUniqueId();
  }

  getLocalizedNotificationKeySuffix() {
    return "";
  }

  getDeviceNameInNotificationContent(alarm) {
    return alarm["p.device.name"];
  }

  getNicName() {

  }

  getNicUUID() {
    const nic = this.getNicName();
    if (nic) {
      const intf = sysManager.getInterface(nic);
      return intf && intf.uuid;
    }
    return null;
  }

  async spoof(state) {
    this.monitoring = state;
  }

  isMonitoring() {
    return this.monitoring;
  }

  async qos(state) {
    const identityIpsetName = this.constructor.getEnforcementIPsetName(this.getUniqueId());
    const identityIpsetName6 = this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6);
    if (state === true) {  
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${identityIpsetName}`).catch((err) => {
        log.error(`Failed to remove ${identityIpsetName} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${identityIpsetName6}`).catch((err) => {
        log.error(`Failed to remove ${identityIpsetName6} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${identityIpsetName}`).catch((err) => {
        log.error(`Failed to add ${identityIpsetName} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${identityIpsetName6}`).catch((err) => {
        log.error(`Failed to add ${identityIpsetName6} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    }
  }

  async acl(state) {
    const identityIpsetName = this.constructor.getEnforcementIPsetName(this.getUniqueId());
    const identityIpsetName6 = this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6);
    if (state === true) {  
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${identityIpsetName}`).catch((err) => {
        log.error(`Failed to remove ${identityIpsetName} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${identityIpsetName6}`).catch((err) => {
        log.error(`Failed to remove ${identityIpsetName6} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${identityIpsetName}`).catch((err) => {
        log.error(`Failed to add ${identityIpsetName} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${identityIpsetName6}`).catch((err) => {
        log.error(`Failed to add ${identityIpsetName6} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    }
  }

  async vpnClient(policy) {
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      if (!profileId) {
        log.warn("VPN client profileId is not specified for " + this.o.cn);
        return false;
      }
      const ovpnClient = new OpenVPNClient({profileId: profileId});
      const intf = ovpnClient.getInterfaceName();
      const rtId = await vpnClientEnforcer.getRtId(intf);
      if (!rtId)
        return false;
      const rtIdHex = Number(rtId).toString(16);
      if (state === true) {
        // set skbmark
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId())}`);
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId())} skbmark 0x${rtIdHex}/${routing.MASK_VC}`);
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)}`);
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)} skbmark 0x${rtIdHex}/${routing.MASK_VC}`);
      }
      // null means off
      if (state === null) {
        // clear skbmark
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId())}`);
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId())} skbmark 0x0000/${routing.MASK_VC}`);
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)}`);
        await exec(`sudo ipset -! add c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)} skbmark 0x0000/${routing.MASK_VC}`);
      }
      // false means N/A
      if (state === false) {
        // do not change skbmark
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId())}`);
        await exec(`sudo ipset -! del c_vpn_client_tag_m_set ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)}`);
      }
      return true;
    } catch (err) {
      log.error("Failed to set VPN client access on " + this.o.cn);
      return false;
    }
  }

  async _dnsmasq(policy) {
    const dnsCaching = policy.dnsCaching;
    const identityIpsetName = this.constructor.getEnforcementIPsetName(this.getUniqueId());
    const identityIpsetName6 = this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6);
    if (dnsCaching === true) {
      let cmd =  `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${identityIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${identityIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${identityIpsetName6}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${identityIpsetName6} ${this.o.intf}`, err);
      });
    } else {
      let cmd = `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${identityIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${identityIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${identityIpsetName6}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${identityIpsetName6} ${this.o.intf}`, err);
      });
    }
  }
}

module.exports = Identity;