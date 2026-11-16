// Fixtures module for the generic HTTP adapter test: employees come from the in-memory mock (globalThis.__bridgeMock).
export default async function createFixtures() {
  const mock = globalThis.__bridgeMock
  return {
    platform: `t${Math.random().toString(16).slice(2, 10)}`,
    roles: ['admin', 'manager', 'staff'],
    employees: { admin: mock.newUser('admin'), manager: mock.newUser('manager'), staff: mock.newUser('staff') },
    newEmployee: async (role) => mock.newUser(role),
  }
}
