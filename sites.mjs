// The two test sites, under names that read as two separate sites. Both run on
// this machine; Firefox resolves the names here through network.dns.localDomains,
// which the demo, agent and test scripts set on their throwaway profiles.
export const PORTAL = "http://springfield-health.test:8080";
export const OUTSIDE = "http://medlookup.test:8081";
export const SITE_PREFS = {
  "network.dns.localDomains": "springfield-health.test,medlookup.test",
  "dom.security.https_first": false,
};
