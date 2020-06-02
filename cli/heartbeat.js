/*    Copyright 2020 Firewalla INC
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

 /*
  * Box (collect the following info)
  *   box states: just rebooted, this process crashed and connect, reconnected the socket io, scheduled update
  *   memory size
  *   mac addresses of ethX
  *   speed of each ethX
  *   Bluetooth mac address
  *   uptime
  *   uname -m
  *   box eid (if have)
  *   box license (8 char prefix only)
  *   gateway mac address (the first three bytes)
  *   cpu temp
  *   current timestamp
  *   hash of firerouter (if applicable)
  *   hash of firewalla
  */

'use strict';

const io2 = require('socket.io-client');
const url = "https://api.firewalla.com";
const path = "/socket";

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);


const cp = require('child_process');
const mac =  getSignatureMac();
const memory = getTotalMemory()
const gatewayMac = getGatewayMac();

function getSignatureMac() {
  try {
    const mac = cp.execSync("cat /sys/class/net/eth0/address", { encoding: 'utf8' });
    return mac && mac.trim().toUpperCase();
  } catch(err) {
    return "";
  }
}

function getGatewayMac() {
  const sysManager = require('../net2/SysManager.js');
  const inter = sysManager.getDefaultWanInterface()
  const gateway = inter.gateway_ip;
  const arpCmd = `arp -a -n | grep ${gateway} -w | awk '{print $4}'`;
  const result = cp.exec(arpCmd);
  const mac = result.stdout;
  if (mac) {
    return mac.substring(0,11);
  } else {
    return null;
  }
}

const socket = io2(url, { path: path, transports: ['websocket'], 'upgrade': false });

function log(message) {
  console.log(new Date(), message);
}

function isBooted() {
  const fw_hb_file = '/dev/shm/fw_heartbeat';
  try{
    if (fs.existsSync(fw_hb_file)) {
      return false;
    } else {
      log("System was booted.");
      cp.execSync(`touch ${fw_hb_file}`)
      return true;
    }
  } catch (err) {
    return false;
  }
}

function getTotalMemory() {
  const result = cp.exec("free -m | awk '/Mem:/ {print $2}'");
  return result && result.stdout && result.stdout.replace(/\n$/, '')
}

function getSysinfo(status) {
  const booted = isBooted();
  const uptime = require('os').uptime()
  return {booted, gatewayMac, mac, memory, status, uptime};
}

function update(status) {
  const info = getSysinfo(status);
  socket.emit('update', info);
}

const job = setTimeout(() => {
  update("schedule");
}, 30 * 3600 * 1000);

socket.on('connect', () => {
  log("Connected to heartbeat server.");
  update('connect');
});

socket.on('disconnect', () => {
  log("Disconnected from heartbeat server.");
});

socket.on("update", (data) => {
  update("cloud");
});

socket.on('reconnect', () => {
  log("Reconnected to heartbeat server.");
  update('reconnect');
});