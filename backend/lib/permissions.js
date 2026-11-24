// Who may do what on the Setup page, beyond opening it (core's page access).
// Policy (limits, tools, who may switch): administrators and developers.
// Model switch and benchmark: those two, plus the roles and people an
// administrator or developer adds.
const { getSetting, setSetting } = require('./settings');

const POLICY_ROLES = ['administrator', 'developer'];

async function isPolicyUser(coreApi, user) {
  const roles = await coreApi.getUserRoles(user);
  return roles.some(r => POLICY_ROLES.includes(r));
}

async function getSwitchers(pool) {
  const s = (await getSetting(pool, 'switchers', null)) || {};
  return { roles: Array.isArray(s.roles) ? s.roles : [], users: Array.isArray(s.users) ? s.users : [] };
}

async function canSwitch(coreApi, user) {
  const roles = await coreApi.getUserRoles(user);
  if (roles.some(r => POLICY_ROLES.includes(r))) return true;
  const s = await getSwitchers(coreApi.pool);
  return s.users.includes(user.id) || roles.some(r => s.roles.includes(r));
}

// Only roles and people that really exist are stored.
async function saveSwitchers(coreApi, value, userId) {
  const roles = await coreApi.listRoles();
  const users = new Set((await coreApi.listUsers()).map(u => Number(u.id)));
  const clean = {
    roles: [...new Set(Array.isArray(value.roles) ? value.roles : [])].filter(r => roles.includes(r) && !POLICY_ROLES.includes(r)),
    users: [...new Set((Array.isArray(value.users) ? value.users : []).map(Number))].filter(id => users.has(id))
  };
  await setSetting(coreApi.pool, 'switchers', clean, userId);
  return clean;
}

// Express middleware factories; mount after authenticateToken.
const requirePolicy = coreApi => async (req, res, next) => {
  try {
    if (await isPolicyUser(coreApi, req.user)) return next();
  } catch (err) { /* refuse below */ }
  return res.status(403).json({ error: 'Only administrators and developers can change this.' });
};
const requireSwitch = coreApi => async (req, res, next) => {
  try {
    if (await canSwitch(coreApi, req.user)) return next();
  } catch (err) { /* refuse below */ }
  return res.status(403).json({ error: 'You are not allowed to switch the AI model.' });
};

module.exports = { POLICY_ROLES, isPolicyUser, canSwitch, getSwitchers, saveSwitchers, requirePolicy, requireSwitch };
