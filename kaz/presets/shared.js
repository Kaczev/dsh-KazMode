// The group marker keeps child !!js values deferred until their plugins mount.
// Use the Host registry directly: linked bundles cannot import Host-only packages
// through ordinary Node resolution, and must not install a second DSH runtime.
export function createPresetPlugin() {
  return Object.assign(async function kazPreset(ctx, config) {
    return ctx.agentPresets.register(config);
  }, {
    inject: ['agentPresets'],
    [Symbol.for('cordis.group')]: true,
  });
}
