// File with unreachable import - intentionally bad for testing merge-gate
import { NonExistentModule } from './does-not-exist';

interface User {
  id: number;
  name: string;
}

// This is unreachable because the import above will fail
function getUser(id: number): User {
  return { id, name: 'Test User' };
}

export { getUser };
