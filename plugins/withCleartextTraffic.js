// Local Expo config plugin: force-permit cleartext (HTTP) traffic on Android.
//
// The `android.usesCleartextTraffic` flag in app.json sets the manifest
// attribute, but it can be silently overridden or dropped. This plugin ALSO
// generates an explicit res/xml/network_security_config.xml that permits
// cleartext, and wires it into the <application> tag. A network security
// config takes precedence and cannot be ignored, so plain http:// endpoints
// (e.g. the ASMX save URL) work in release builds.
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NSC_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

function withNetworkSecurityXmlFile(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml',
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), NSC_XML);
      return cfg;
    },
  ]);
}

function withNetworkSecurityManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
      app.$['android:usesCleartextTraffic'] = 'true';
    }
    return cfg;
  });
}

module.exports = function withCleartextTraffic(config) {
  config = withNetworkSecurityXmlFile(config);
  config = withNetworkSecurityManifest(config);
  return config;
};
