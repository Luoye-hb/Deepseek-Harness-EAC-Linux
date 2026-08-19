'use strict';

function customFrameOptions(platform = process.platform) {
  if (platform === 'win32') {
    return { frame: false, roundedCorners: true };
  }
  if (platform === 'linux') {
    return { frame: false };
  }
  return {};
}

module.exports = { customFrameOptions };
