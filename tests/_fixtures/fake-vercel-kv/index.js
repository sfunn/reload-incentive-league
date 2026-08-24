// Test-only stand-in for @vercel/kv. Never used in production -- the CI
// workflow copies this OVER the real installed package, inside the CI
// runner only, after npm install, right before running the safety tests.
// The real repo's package.json still depends on the real @vercel/kv for
// actual deployment; this file never ships to Vercel.
global.__fakeStore = global.__fakeStore || {};
const kv = {
  async get(key) {
    return global.__fakeStore[key] === undefined ? null : global.__fakeStore[key];
  },
  async set(key, value) {
    global.__fakeStore[key] = value;
    return "OK";
  },
};
module.exports = { kv };
