// Ambient indicators use existing slots; native preset controls stay untouched.
window.__ModuleLoader__.load({
  id: 'dsh-kazmode',
  factory(require) {
    const React = require('react');
    function Indicator({ t, label, inset = false }) {
      return React.createElement('span', {
        title: t('detail'),
        style: {
          fontFamily: 'inherit', fontSize: '14px', fontWeight: 400, lineHeight: '20px',
          color: inset ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap',
          paddingInlineEnd: inset ? '12px' : undefined,
        },
      }, t(label));
    }
    function HeroIndicator(props) { return React.createElement(Indicator, { ...props, label: 'enabled', inset: true }); }
    function HeaderIndicator(props) { return React.createElement(Indicator, { ...props, label: 'suffix' }); }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('kaz-mode', 'zh', {
          enabled: 'Kaz 已启用', suffix: '· Kaz', detail: 'Kaz 模式已叠加：提示词与写作技能已启用，不改变当前预设的工具组合。',
        }));
        ctx.effect(() => ctx.locale.register('kaz-mode', 'en', {
          enabled: 'Kaz enabled', suffix: '· Kaz', detail: 'Kaz mode is active: preferences and writing skill are enabled; preset tools stay unchanged.',
        }));
        for (const [name, order, component] of [
          ['conversation.hero.options', 0, HeroIndicator],
          ['conversation.session.header.actions', -9, HeaderIndicator],
        ]) {
          ctx.slots.inject(name, () => ctx.slots.register({
            name, id: 'kaz-mode-indicator', order, locale: 'kaz-mode',
          }, component));
        }
      },
    };
  },
});
