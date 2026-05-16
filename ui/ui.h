#ifndef UI_H
#define UI_H

#include <SDL2/SDL.h>
#include <SDL2/SDL_ttf.h>
#include "../states/states.h"

typedef void (*RenderFn)(SDL_Renderer*, TTF_Font*, TTF_Font*, const AmountInput*);

void renderIdleScreen(SDL_Renderer *renderer, TTF_Font *font, TTF_Font *fontLarge, const AmountInput *amount);
void renderEnterAmountScreen(SDL_Renderer *renderer, TTF_Font *font, TTF_Font *fontLarge, const AmountInput *amount);
void renderProcessingScreen(SDL_Renderer *renderer, TTF_Font *font, TTF_Font *fontLarge, const AmountInput *amount);
void renderWaitingScreen(SDL_Renderer *renderer, TTF_Font *font, TTF_Font *fontLarge, const AmountInput *amount);
void renderConfirmedScreen(SDL_Renderer *renderer, TTF_Font *font, TTF_Font *fontLarge, const AmountInput *amount);
void renderFailedScreen(SDL_Renderer *renderer, TTF_Font *font, TTF_Font *fontLarge, const AmountInput *amount);
void renderHistoryScreen(SDL_Renderer *renderer, TTF_Font *font, TTF_Font *fontLarge, const AmountInput *amount);
void renderBalanceScreen(SDL_Renderer *renderer, TTF_Font *font, TTF_Font *fontLarge, const AmountInput *amount);

extern RenderFn renderScreen[STATE_COUNT];

#endif
