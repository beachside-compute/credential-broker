import journal from "./meta/_journal.json";
import m0000 from "./0000_grants.sql";
import m0001 from "./0001_integrations.sql";
import m0002 from "./0002_configurable_endpoints.sql";
import m0003 from "./0003_grant_details.sql";
import m0004 from "./0004_request_limits.sql";
import m0005 from "./0005_canaries.sql";
import m0006 from "./0006_tenants.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
    m0006,
  },
};
