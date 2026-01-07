// common/decorators/api-standard-response.decorator.ts
import { applyDecorators, Type } from '@nestjs/common';
import { ApiOkResponse, getSchemaPath, ApiExtraModels } from '@nestjs/swagger';
import { ApiResponseDto } from '../dtos/api-response.dto';

export const ApiStandardResponse = <TModel extends Type<any>>(
  model: TModel,
) => {
  return applyDecorators(
    // 1. Tell Swagger about the specific DTO (e.g., UserDto) and the Wrapper
    ApiExtraModels(ApiResponseDto, model),
    
    // 2. Define the schema
    ApiOkResponse({
      description: 'Standard API Response',
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiResponseDto) }, // 1. Base properties (status, timestamp...)
          {
            properties: {
              // 2. Overwrite the 'data' property with the specific DTO
              data: {
                $ref: getSchemaPath(model),
              },
            },
          },
        ],
      },
    }),
  );
};