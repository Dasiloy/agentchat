import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class CreateDmDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  email: string;
}
