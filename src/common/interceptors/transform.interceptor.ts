import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
  statusCode: number;
  success: boolean;
  message?: string;
  data: T;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, Response<T>> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<Response<T>> {
    return next.handle().pipe(
      map((data) => {
        // Access the native response object to get the status code
        const ctx = context.switchToHttp();
        const response = ctx.getResponse();
        
        
        const message = data?.message || null;
        
        // If data contains 'message', clean it up so 'data' only contains the payload
        // (This part is optional, depends on your preference)
        const finalData = data; 

        return {
          statusCode: response.statusCode,
          success: true,
          message: message, 
          data: finalData,
          timestamp: new Date().toISOString(),
          path: ctx.getRequest().url,
        };
      }),
    );
  }
}