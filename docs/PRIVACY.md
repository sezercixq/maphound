# Privacy policy

_Last updated: 20 November 2026 (version 0.2.0)_

MapHound is a browser extension that helps developers and security teams find source maps and
leaked credentials in the JavaScript of websites they choose. **MapHound does not collect, transmit,
sell or share any user data. All analysis happens locally in your browser.**

## What MapHound does

On a site you explicitly enable, MapHound:

1. reads the addresses (URLs) of the scripts that the page loads. It does not read page text, form
   input, cookies, passwords or browsing history;
2. downloads those scripts, and the source maps they declare, from that same site;
3. rebuilds the original source files from the source maps and scans them for credentials;
4. shows the results in the side panel and, if you ask, saves them to a ZIP file on your computer.

## Data collection and transmission

- **No data is sent to the developer or to any third party.** There is no analytics, telemetry,
  crash reporting, account, advertising or tracking.
- **No remote code.** All code ships inside the extension package; detection rules are compiled into
  the package at build time and are not downloaded.
- **No credential validation online.** Found secrets are checked offline (format and checksum) only.
  MapHound never contacts a provider to test a key.
- **The only network requests** MapHound makes are to the site you enabled (and, if you choose,
  its subdomains), to download scripts and source maps the site already serves publicly. They are
  sent without cookies unless you turn that on for the site. Scripts from other domains (CDNs,
  analytics) are listed as "third party (not scanned)" and are not downloaded unless you click
  **Allow & scan** for that origin, which asks Chrome for access to that origin only.

## Data stored on your device

Downloaded scripts and source maps, the rebuilt file index, the list of enabled sites and the
findings (including the raw value of each found secret, so you can copy it) are stored in the
extension's IndexedDB database in your Chrome profile. They never leave your device unless you
export a ZIP, which you save yourself. The exported `findings.json` contains raw secret values only
if you tick the option to include them; `FINDINGS.md` is always masked.

To delete data, click **Disable and delete data** for a site in the side panel, or remove the
extension; Chrome then deletes all of its storage.

## Permissions and why they are needed

| Permission                                         | Why                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidePanel`                                        | The user interface is a Chrome side panel.                                                                                                                                                                                                                                                                                                     |
| `activeTab`                                        | Read the address of the current tab when you click the toolbar icon, so the panel can offer to enable that site.                                                                                                                                                                                                                               |
| `scripting`                                        | Register the script-URL collector on the sites you enable, and inject it into tabs of that site that are already open.                                                                                                                                                                                                                         |
| `offscreen`                                        | Host the background worker that parses source maps and scans for secrets, which a service worker cannot do itself.                                                                                                                                                                                                                             |
| `alarms`                                           | Resume interrupted downloads and scans after Chrome suspends the service worker.                                                                                                                                                                                                                                                               |
| Optional host access (`https://*/*`, `http://*/*`) | Declared as optional only. Chrome asks for access to one site at a time when you click **Enable this site**, and to individual extra origins (for example the site's CDN) when you click **Allow & scan**. Access is used only to download scripts and maps from those origins, and is removed when you remove the origin or disable the site. |

MapHound requests no host access at install time, injects no content script into sites you have not
enabled, and does not use `webRequest`, `cookies`, `history`, `tabs` or `downloads`.

## Chrome Web Store disclosures

- Single purpose: rebuild source maps and find leaked credentials in the JavaScript of sites the user
  enables, locally.
- The extension processes **website content** (scripts and source maps of enabled sites) only to
  provide this feature, only on the user's device.
- The developer does not collect user data, does not sell or transfer it, does not use it for
  purposes unrelated to the single purpose, and does not use it for creditworthiness or lending.

## Responsible use

Use MapHound on applications you own or are authorized to test. If you find a credential on someone
else's website, report it to the site owner and do not use it.

## Changes and contact

Changes to this policy are published in this file with a new date. Questions:
[open an issue](https://github.com/sezercixq/maphound/issues) or, for security matters, see
[`SECURITY.md`](../SECURITY.md).
