/** A disposed generation cannot clear a later Host connection. */
export function createConnectionOwner() {
  let current = null;
  return {
    connection: { get rpc() { return current?.connection?.rpc; } },
    bind(connection) {
      const owner = { connection };
      current = owner;
      return () => { if (current === owner) current = null; };
    },
  };
}
