// node removeContainers.mjs <pid>
//
// Removes the database containers started by the process <pid>. containers.mjs runs it when that
// process exits without having stopped its databases (Ctrl+C during the tests, for instance).

import { removeContainers } from "./containers.mjs";

const owner = Number(process.argv[2]);
if (!Number.isInteger(owner)) throw new Error("Usage: node removeContainers.mjs <pid>");
await removeContainers((ownerPid) => ownerPid === owner);
