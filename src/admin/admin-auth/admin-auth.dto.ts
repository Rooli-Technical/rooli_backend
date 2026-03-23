import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength } from "class-validator";

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@rooli.io' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'SuperSecretPassword123' })
  @IsString()
  @MinLength(5)
  password: string;
}

export class AdminUserDto {
  @ApiProperty({ example: 'clx1234abc' })
  id: string;

  @ApiProperty({ example: 'admin@rooli.io' })
  email: string;

  @ApiProperty({ example: 'John', nullable: true })
  firstName: string | null;

  @ApiProperty({ example: 'Doe', nullable: true })
  lastName: string | null;

  @ApiProperty({ example: 'SUPER_ADMIN' })
  role: string;
}

export class AdminLoginResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({ type: AdminUserDto })
  user: AdminUserDto;
}

export class AdminMeResponseDto {
  @ApiProperty({ example: 'clx1234abc' })
  userId: string;

  @ApiProperty({ example: 'admin@rooli.io' })
  email: string;

  @ApiProperty({ example: 'SUPER_ADMIN' })
  role: string;
}
