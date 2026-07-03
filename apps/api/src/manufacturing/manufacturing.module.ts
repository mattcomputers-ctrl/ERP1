import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { RecipeEditorService } from './recipe-editor.service';
import { RecipeReplacementService } from './recipe-replacement.service';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [RecipesController],
  providers: [RecipesService, RecipeEditorService, RecipeReplacementService],
})
export class ManufacturingModule {}
