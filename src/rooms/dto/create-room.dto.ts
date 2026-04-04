import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateRoomDto {
  @ApiProperty({ example: 'general' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'General discussion channel' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
