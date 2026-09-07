// Valid test file for merge-gate
interface User {
  id: number;
  name: string;
}

function getUser(id: number): User {
  return { id, name: 'Test User' };
}

export { getUser };
