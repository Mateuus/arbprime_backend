import { Request } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    userData?: { userId: string; email: string; role: string };
  }
}