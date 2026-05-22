export function visible() {
  return (_, { addInitializer, access }) => {
    addInitializer(function () {
      this.effect(
        () => {
          const fn = access.get.call(this, this).bind(this);
          const handler = () => {
            if (document.visibilityState === 'visible') fn();
          };
          document.addEventListener('visibilitychange', handler);
          return () => document.removeEventListener('visibilitychange', handler);
        },
        () => [],
      );
    });
  };
}
