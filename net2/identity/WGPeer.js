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

const log = require('../logger.js')(__filename);

const { Address4, Address6 } = require('ip-address');
const sysManager = require('../SysManager.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();

const Promise = require('bluebird');
const fs = require('fs');
Promise.promisifyAll(fs);
const Constants = require('../Constants.js');
const NetworkProfile = require('../NetworkProfile.js');
const Message = require('../Message.js');
const FireRouter = require('../FireRouter.js');
const exec = require('child-process-promise').exec;

const wgPeers = {};

const Identity = require('../Identity.js');

class WGPeer extends Identity {
  getUniqueId() {
    return this.o && this.o.publicKey;
  }

  static isEnabled() {
    return platform.isWireguardSupported();
  }

  static getNamespace() {
    return Constants.NS_WG_PEER;
  }

  static getKeyOfUIDInAlarm() {
    return "p.device.wgPeer";
  }

  static getKeyOfInitData() {
    return "wgPeers";
  }

  static async getInitData() {
    const hash = await super.getInitData();
    const peers = [];
    for (const key of Object.keys(hash)) {
      peers.push(hash[key]);
    }
    return peers;
  }

  static getDnsmasqConfigDirectory(uid) {
    if (platform.isFireRouterManaged()) {
      const vpnIntf = sysManager.getInterface("wg0");
      const vpnIntfUUID = vpnIntf && vpnIntf.uuid;
      if (vpnIntfUUID && sysManager.getInterfaceViaUUID(vpnIntfUUID)) {
        return `${NetworkProfile.getDnsmasqConfigDirectory(vpnIntfUUID)}`;
      }
    }
    return super.getDnsmasqConfigDirectory(uid);
  }

  static async getIdentities() {
    const result = {};
    if (platform.isFireRouterManaged()) {
      const networkConfig = FireRouter.getConfig();
      const peers = networkConfig && networkConfig.interface && networkConfig.interface.wireguard && networkConfig.interface.wireguard.wg0 && networkConfig.interface.wireguard.wg0.peers || [];
      const peersExtra = networkConfig && networkConfig.interface && networkConfig.interface.wireguard && networkConfig.interface.wireguard.wg0 && networkConfig.interface.wireguard.wg0.extra && networkConfig.interface.wireguard.wg0.extra.peers || [];
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        const allowedIPs = peer.allowedIPs;
        result[pubKey] = {
          publicKey: pubKey,
          allowedIPs: allowedIPs
        };
      }
      for (const peerExtra of peersExtra) {
        const name = peerExtra.name;
        const privateKey = peerExtra.privateKey;
        const pubKey = await exec(`echo ${privateKey} | wg pubkey`).then(result => result.stdout.trim()).catch((err) => {
          log.error(`Failed to calculate public key from private key ${privateKey}`, err.message);
          return null;
        });
        if (pubKey && result[pubKey]) {
          result[pubKey].name = name;
        }
      }
    } else {
      const wireguard = require('../../extension/wireguard/wireguard.js');
      const peers = await wireguard.getPeers();
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        result[pubKey] = peer;
      }
    }

    for (const pubKey of Object.keys(wgPeers))
      wgPeers[pubKey].active = false;

    for (const pubKey of Object.keys(result)) {
      const o = result[pubKey];
      o.publicKey = pubKey;
      if (wgPeers[pubKey])
        wgPeers[pubKey].update(o);
      else
        wgPeers[pubKey] = new WGPeer(o);
      wgPeers[pubKey].active = true;
    }

    const removedPeers = {};
    Object.keys(wgPeers).filter(pubKey => wgPeers[pubKey].active === false).map((pubKey) => {
      removedPeers[pubKey] = wgPeers[pubKey];
    });
    for (const pubKey of Object.keys(removedPeers))
      delete wgPeers[pubKey];
    return wgPeers;
  }

  static async getIPUniqueIdMappings() {
    const result = {};
    if (platform.isFireRouterManaged()) {
      const networkConfig = FireRouter.getConfig();
      const peers = networkConfig && networkConfig.interface && networkConfig.interface.wireguard && networkConfig.interface.wireguard.wg0 && networkConfig.interface.wireguard.wg0.peers || [];
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        const allowedIPs = peer.allowedIPs || [];
        for (const ip of allowedIPs) {
          result[ip] = pubKey;
        }
      }
    } else {
      const wireguard = require('../../extension/wireguard/wireguard.js');
      const peers = await wireguard.getPeers();
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        const allowedIPs = peer.allowedIPs || [];
        for (const ip of allowedIPs) {
          result[ip] = pubKey;
        }
      }
    }
    return result;
  }

  static async getIPEndpointMappings() {
    const pubKeyEndpointMap = {};
    const endpointsResults = (await exec(`sudo wg show wg0 endpoints`).then(result => result.stdout.trim().split('\n')).catch((err) => {
      log.debug(`Failed to show endpoints using wg command`, err.message);
      return [];
    })).map(result => result.split(/\s+/g));
    for (const endpointResult of endpointsResults) {
      const pubKey = endpointResult[0];
      const endpoint = endpointResult[1];
      if (pubKey && endpoint)
        pubKeyEndpointMap[pubKey] = endpoint;
    }

    const result = {};
    if (platform.isFireRouterManaged()) {
      const networkConfig = FireRouter.getConfig();
      const peers = networkConfig && networkConfig.interface && networkConfig.interface.wireguard && networkConfig.interface.wireguard.wg0 && networkConfig.interface.wireguard.wg0.peers || [];
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        const allowedIPs = peer.allowedIPs || [];
        for (const ip of allowedIPs) {
          if (pubKeyEndpointMap[pubKey])
            result[ip] = pubKeyEndpointMap[pubKey];
        }
      }
    } else {
      const wireguard = require('../../extension/wireguard/wireguard.js');
      const peers = await wireguard.getPeers();
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        const allowedIPs = peer.allowedIPs || [];
        for (const ip of allowedIPs) {
          if (pubKeyEndpointMap[pubKey])
            result[ip] = pubKeyEndpointMap[pubKey];
        }
      }
    }
    return result;
  }

  static getRefreshIdentitiesHookEvents() {
    return [Message.MSG_SYS_NETWORK_INFO_RELOADED];
  }

  static getRefreshIPMappingsHookEvents() {
    return [Message.MSG_WG_CONN_ACCEPTED];
  }

  getLocalizedNotificationKeySuffix() {
    return ".ovpn";
  }

  getReadableName() {
    return this.o && this.o.name || this.getUniqueId();
  }

  getNicName() {
    return "wg0";
  }
}

module.exports = WGPeer;