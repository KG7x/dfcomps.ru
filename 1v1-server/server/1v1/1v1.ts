const config = require('./../config.json');

import { DuelWebsocketClientActions } from './enums/duel-websocket-client-actions.enum';
import { DuelClientMessage } from './types/duel-client-message.type';
import * as WebSocket from 'ws';
import axios from 'axios';
import { DuelServerMessageType } from './types/duel-server-message.type';
import { DuelWebsocketServerActions } from './enums/duel-websocket-server-actions.enum';
import { Physics } from '../enums/physics.enum';
import { BehaviorSubject, timer, from } from 'rxjs';
import { take, switchMap } from 'rxjs/operators';
import { MatchStates } from './enums/match-states.enum';
import { ClientInterface } from '../interfaces/client.interface';
import { MatchInterface } from './interfaces/match.interface';
import { PickbanMapServerInterface } from './interfaces/pickban-map-server.interface';
import { ServerMatchInterface } from './interfaces/server-match.interface';
import { maps } from './constants/maps';
import { routes } from './config/routes';

interface QueueInterface {
    playerId: string;
    physics: Physics;
}

const BAN_TIMER_SECONDS = 30;
const MATCH_TIMER_SECONDS = 15 * 60;
const BAN_TIMER = BAN_TIMER_SECONDS * 1000;
const MATCH_TIMER = MATCH_TIMER_SECONDS * 1000;
const LAG_COMPENSATION = 1000;

export class OneVOneHandler {
    private queue$ = new BehaviorSubject<QueueInterface[]>([]);
    private matches$ = new BehaviorSubject<ServerMatchInterface[]>([]);
    private clients$ = new BehaviorSubject<ClientInterface[]>([]);
    private finishedMatchPlayers$ = new BehaviorSubject<string[]>([]);

    public addClient(playerId: string, socket: WebSocket, uniqueId: string): void {
        // TODO Перевести все логи на текстовые
        console.log('CHECKING FOR EXISTING CLIENT');
        console.log(this.clients$.value.map((client) => ({ playerId: client.playerId, uniqueId: client.uniqueId })));

        const existingClient = this.clients$.value.find((client: ClientInterface) => client.playerId === playerId);

        // проверка на совпадение playerId (может быть повторное сообщение с вкладки, обновление страницы, либо вторая вкладка)
        if (existingClient) {
            // проверяем на повторное сообщение с той же вкладки по тому же сокету, здесь не нужно добавление клиента
            if (existingClient.uniqueId === uniqueId) {
                return;
            }

            // если уже есть открытый сокет, то значит открыта вторая вкладка.
            // посылаем сообщение о дублирующейся вкладке ПЕРВОМУ клиенту и закрываем его
            if (existingClient.socket.readyState === WebSocket.OPEN) {
                console.log(`sending duplicate to ${uniqueId}`);
                this.send(existingClient.socket, { action: DuelWebsocketServerActions.DUPLICATE_CLIENT });
                existingClient.socket.close();
            }

            // кейс обновления страницы, предыдущий сокет при этом должен быть закрыт; тогда обновляем сокет для клиента
            // либо каким-то образом с одной страницы было создано два сокета
            this.clients$.next(this.clients$.value.map((client: ClientInterface) => (client.playerId === playerId ? { uniqueId, playerId, socket } : client)));

            return;
        }

        this.clients$.next([
            ...this.clients$.value,
            {
                uniqueId,
                playerId,
                socket,
            },
        ]);
    }

    public removeClient(uniqueId: string): void {
        this.clients$.next(this.clients$.value.filter((client: ClientInterface) => client.uniqueId !== uniqueId));
    }

    public initSubscriptions(): void {
        this.queue$.subscribe((queue: QueueInterface[]) => {
            console.log(`clients list: ${JSON.stringify(this.clients$.value.map((client) => client.playerId))}`);

            const cpmPlayersInQueue = queue.filter((player: QueueInterface) => player.physics === Physics.CPM);
            const vq3PlayersInQueue = queue.filter((player: QueueInterface) => player.physics === Physics.VQ3);

            if (cpmPlayersInQueue.length > 1) {
                console.log('CPM match found');
                this.startMatch(cpmPlayersInQueue[0].playerId, cpmPlayersInQueue[1].playerId, Physics.CPM);
            }

            if (vq3PlayersInQueue.length > 1) {
                console.log('VQ3 match found');
                this.startMatch(vq3PlayersInQueue[0].playerId, vq3PlayersInQueue[1].playerId, Physics.VQ3);
            }
        });
    }

    public processClientMessage(socket: WebSocket, message: DuelClientMessage): void {
        console.log(`received: ${JSON.stringify(message)}`);

        if (message.action === DuelWebsocketClientActions.JOIN_QUEUE) {
            if (this.getPlayerInQueue(message.playerId)) {
                this.send(socket, { action: DuelWebsocketServerActions.JOIN_QUEUE_FAILURE, payload: { error: 'Already in queue' } });

                return;
            }

            this.send(socket, { action: DuelWebsocketServerActions.JOIN_QUEUE_SUCCESS }, () =>
                this.addPlayerToQueue(message.playerId, message.payload.physics),
            );
        }

        if (message.action === DuelWebsocketClientActions.GET_PLAYER_STATE) {
            const queueItem: QueueInterface | undefined = this.getPlayerInQueue(message.playerId);

            if (queueItem) {
                this.send(socket, { action: DuelWebsocketServerActions.PLAYER_STATE, payload: { state: MatchStates.IN_QUEUE, physics: queueItem.physics } });

                return;
            }

            const match: ServerMatchInterface | undefined = this.getPlayerMatch(message.playerId);

            if (match) {
                const availableMaps = match.maps.filter(
                    ({ isBannedByFirstPlayer, isBannedBySecondPlayer }: PickbanMapServerInterface) => !isBannedByFirstPlayer && !isBannedBySecondPlayer,
                );
                const timerStartValue = availableMaps.length > 1 ? BAN_TIMER_SECONDS : MATCH_TIMER_SECONDS;
                const timerValue = timerStartValue - Math.floor((Date.now() - match.timerStartTime) / 1000);
                const clientMatch: MatchInterface = this.mapServerMatchToMatchDto({ ...match, timer: timerValue > 0 ? timerValue : 0 });

                this.send(socket, {
                    action: DuelWebsocketServerActions.PLAYER_STATE,
                    payload: { state: MatchStates.MATCH_IN_PROGRESS, match: clientMatch },
                });

                return;
            }

            const finishedMatchPlayer: string | undefined = this.finishedMatchPlayers$.value.find((playerId: string) => playerId === message.playerId);

            if (finishedMatchPlayer) {
                this.send(socket, {
                    action: DuelWebsocketServerActions.PLAYER_STATE,
                    payload: { state: MatchStates.MATCH_FINISHED },
                });

                return;
            }

            this.send(socket, { action: DuelWebsocketServerActions.PLAYER_STATE, payload: { state: MatchStates.WAITING_FOR_QUEUE } });
        }

        if (message.action === DuelWebsocketClientActions.LEAVE_QUEUE) {
            this.removePlayerFromQueue(message.playerId);

            this.send(socket, { action: DuelWebsocketServerActions.LEAVE_QUEUE_SUCCESS });
        }

        if (message.action === DuelWebsocketClientActions.BAN_MAP) {
            const playerId = message.playerId;
            const match = this.matches$.value.find((match: ServerMatchInterface) => match.firstPlayerId === playerId || match.secondPlayerId === playerId);

            if (!match) {
                // TODO Нужна обработка ошибок, матч не найден
                console.log('match not found');
                return;
            }

            this.banMap(match, message.payload.mapName, playerId);
        }

        if (message.action === DuelWebsocketClientActions.MATCH_RESULT_ACCEPTED) {
            this.finishedMatchPlayers$.next(this.finishedMatchPlayers$.value.filter((playerId: string) => playerId !== message.playerId));
        }
    }

    public sendDuplicateClientMessage(socket: WebSocket): void {
        this.send(socket, { action: DuelWebsocketServerActions.DUPLICATE_CLIENT });
    }

    private send(socket: WebSocket, message: DuelServerMessageType, callback?: () => void): void {
        callback ? socket.send(JSON.stringify(message), callback) : socket.send(JSON.stringify(message));

        console.log(`sent: ${JSON.stringify(message)}`);
    }

    private getPlayerInQueue(playerId: string): QueueInterface | undefined {
        return this.queue$.value.find((item: QueueInterface) => item.playerId === playerId);
    }

    private addPlayerToQueue(playerId: string, physics: Physics): void {
        this.queue$.next([...this.queue$.value, { playerId, physics }]);
    }

    private removePlayerFromQueue(playerId: string): void {
        this.queue$.next(this.queue$.value.filter((item: QueueInterface) => item.playerId !== playerId));
    }

    private getRandomMaps(): PickbanMapServerInterface[] {
        const map1: string = maps[Math.floor(Math.random() * maps.length)];
        const map2: string = maps.filter((map) => map != map1)[Math.floor(Math.random() * (maps.length - 1))];
        const map3: string = maps.filter((map) => ![map1, map2].includes(map))[Math.floor(Math.random() * (maps.length - 2))];
        const map4: string = maps.filter((map) => ![map1, map2, map3].includes(map))[Math.floor(Math.random() * (maps.length - 3))];
        const map5: string = maps.filter((map) => ![map1, map2, map3, map4].includes(map))[Math.floor(Math.random() * (maps.length - 4))];
        const randomMaps: string[] = [map1, map2, map3, map4, map5];

        console.log(`randomMaps: ${JSON.stringify(randomMaps)}`);

        return randomMaps.map((name: string) => ({
            name,
            isBannedByFirstPlayer: false,
            isBannedBySecondPlayer: false,
            isPickedByFirstPlayer: false,
            isPickedBySecondPlayer: false,
        }));
    }

    private startMatch(firstPlayerId: string, secondPlayerId: string, physics: Physics): void {
        const isFirstPlayerBanning = Math.random() > 0.5;
        const match: MatchInterface = {
            firstPlayerId,
            secondPlayerId,
            isFirstPlayerBanning,
            isSecondPlayerBanning: !isFirstPlayerBanning,
            maps: this.getRandomMaps(),
            physics,
            timer: BAN_TIMER_SECONDS,
        };

        this.removePlayerFromQueue(firstPlayerId);
        this.removePlayerFromQueue(secondPlayerId);

        const serverMatch: ServerMatchInterface = {
            ...match,
            timerStartTime: Date.now(),
            bannedMapsCount: 0,
        };

        this.doAxiosPostRequest(`${this.getRoutePrefix()}/api/match/start`, {
            firstPlayerId,
            secondPlayerId,
            physics,
            secretKey: config.DUELS_SERVER_PRIVATE_KEY,
        })
            .then(() => {
                this.setCheckForBanTimer(0, isFirstPlayerBanning ? firstPlayerId : secondPlayerId);
                this.matches$.next([...this.matches$.value, serverMatch]);
                this.sendPickBanStepsToMatchPlayers(match);
            })
            .catch(() => {
                // TODO Обработать ошибку
                console.log('rest backend server error');
            });
    }

    private sendPickBanStepsToMatchPlayers(match: MatchInterface): void {
        const firstClient = this.clients$.value.find((client: ClientInterface) => client.playerId === match.firstPlayerId);
        const secondClient = this.clients$.value.find((client: ClientInterface) => client.playerId === match.secondPlayerId);

        if (firstClient) {
            this.send(firstClient.socket, {
                action: DuelWebsocketServerActions.PICKBAN_STEP,
                payload: {
                    match,
                },
            });
        }

        if (secondClient) {
            this.send(secondClient.socket, {
                action: DuelWebsocketServerActions.PICKBAN_STEP,
                payload: {
                    match,
                },
            });
        }
    }

    private getPlayerMatch(playerId: string): ServerMatchInterface | undefined {
        const match: ServerMatchInterface | undefined = this.matches$.value.find(
            (match: ServerMatchInterface) => match.firstPlayerId === playerId || match.secondPlayerId === playerId,
        );

        if (!match) {
            return;
        }

        return match;
    }

    private sendRandomMapBan(banningPlayerId: string): void {
        console.log(`banning random map for player ${banningPlayerId}`);

        const match = this.matches$.value.find(
            (match: ServerMatchInterface) => match.firstPlayerId === banningPlayerId || match.secondPlayerId === banningPlayerId,
        );

        if (!match) {
            console.log('match for random ban not found');
            return;
        }

        const availableMaps = match.maps.filter((map: PickbanMapServerInterface) => !map.isBannedByFirstPlayer && !map.isBannedBySecondPlayer);

        if (availableMaps.length < 2) {
            console.log('available maps for random ban not found');
            return;
        }

        const randomMapName = availableMaps[Math.floor(Math.random() * availableMaps.length)].name;

        this.banMap(match, randomMapName, banningPlayerId);
    }

    private banMap(match: ServerMatchInterface, mapName: string, banningPlayerId: string): void {
        const matchMap = match.maps.find((map: PickbanMapServerInterface) => map.name === mapName);

        if (!matchMap) {
            // TODO Нужна обработка ошибок, карта не в списке матча
            console.log('map not found in match');
            return;
        }

        const availableMaps = match.maps.filter((map: PickbanMapServerInterface) => !map.isBannedByFirstPlayer && !map.isBannedBySecondPlayer);
        const isLastBan = availableMaps.length === 2;

        if (availableMaps.length < 2) {
            // TODO Нужна обработка ошибок, нет доступных карт для бана
            console.log('no available maps for ban');
            return;
        }

        // Updating info on banned map
        this.matches$.next(
            this.matches$.value.map((match: ServerMatchInterface) => {
                const isFirstPlayer = match.firstPlayerId === banningPlayerId;
                const isSecondPlayer = match.secondPlayerId === banningPlayerId;

                if (!isFirstPlayer && !isSecondPlayer) {
                    return match;
                }

                const mappedMaps: PickbanMapServerInterface[] = match.maps.map((map: PickbanMapServerInterface) => {
                    if (map.name !== mapName) {
                        return map;
                    }

                    if (map.isBannedByFirstPlayer || map.isBannedBySecondPlayer) {
                        // TODO Нужна обработка ошибок, карта уже забанена
                        console.log('map already banned');
                        return map;
                    }

                    if (map.isPickedByFirstPlayer || map.isPickedBySecondPlayer) {
                        // TODO Нужна обработка ошибок, карта уже выбрана
                        console.log('map already picked');
                        return map;
                    }

                    return {
                        isBannedByFirstPlayer: isFirstPlayer,
                        isBannedBySecondPlayer: isSecondPlayer,
                        isPickedByFirstPlayer: false,
                        isPickedBySecondPlayer: false,
                        name: map.name,
                    };
                });

                return {
                    ...match,
                    maps: mappedMaps,
                    isFirstPlayerBanning: !match.isFirstPlayerBanning,
                    isSecondPlayerBanning: !match.isSecondPlayerBanning,
                    bannedMapsCount: match.bannedMapsCount + 1,
                    timerStartTime: Date.now(),
                    timer: isLastBan ? MATCH_TIMER_SECONDS : BAN_TIMER_SECONDS,
                };
            }),
        );

        // Updating info on remaining map if needed
        if (isLastBan) {
            this.matches$.next(
                this.matches$.value.map((match: ServerMatchInterface) => {
                    if (match.firstPlayerId !== banningPlayerId && match.secondPlayerId !== banningPlayerId) {
                        return match;
                    }

                    const mappedMaps = match.maps.map((map: PickbanMapServerInterface) =>
                        map.isBannedByFirstPlayer || map.isBannedBySecondPlayer ? map : { ...map, isPickedByFirstPlayer: true, isPickedBySecondPlayer: true },
                    );

                    return { ...match, maps: mappedMaps, isFirstPlayerBanning: false, isSecondPlayerBanning: false };
                }),
            );

            const pickedMap = availableMaps
                .filter((map: PickbanMapServerInterface) => map.name !== mapName)
                .find((map: PickbanMapServerInterface) => !map.isBannedByFirstPlayer && !map.isBannedBySecondPlayer);

            if (pickedMap) {
                this.doAxiosPostRequest(`${this.getRoutePrefix()}/api/match/update_match_map`, {
                    firstPlayerId: match.firstPlayerId,
                    secondPlayerId: match.secondPlayerId,
                    map: pickedMap.name,
                    secretKey: config.DUELS_SERVER_PRIVATE_KEY,
                });
            }
        }

        // Sending info about current match to both players
        const updatedMatch = this.matches$.value.find(
            (match: ServerMatchInterface) => match.firstPlayerId === banningPlayerId || match.secondPlayerId === banningPlayerId,
        );

        if (updatedMatch) {
            if (!isLastBan) {
                console.log(`setting timer for banned maps count ${match.bannedMapsCount + 1}`);
                this.setCheckForBanTimer(match.bannedMapsCount + 1, match.isFirstPlayerBanning ? match.secondPlayerId : match.firstPlayerId);
            } else {
                console.log(`setting timer for match of players ${match.firstPlayerId} and ${match.secondPlayerId}`);
                this.setEndMatchTimer(match.firstPlayerId, match.secondPlayerId);
            }

            this.sendPickBanStepsToMatchPlayers(this.mapServerMatchToMatchDto(updatedMatch));
        }
    }

    private mapServerMatchToMatchDto({
        firstPlayerId,
        secondPlayerId,
        isFirstPlayerBanning,
        isSecondPlayerBanning,
        maps,
        physics,
        timer,
    }: ServerMatchInterface): MatchInterface {
        return {
            firstPlayerId,
            secondPlayerId,
            isFirstPlayerBanning,
            isSecondPlayerBanning,
            maps,
            physics,
            timer,
        };
    }

    private setCheckForBanTimer(bannedMapsCount: number, banningPlayerId: string): void {
        timer(BAN_TIMER + LAG_COMPENSATION)
            .pipe(take(1))
            .subscribe(() => {
                const match = this.matches$.value.find(
                    (match: ServerMatchInterface) => match.firstPlayerId === banningPlayerId || match.secondPlayerId === banningPlayerId,
                );

                if (!match) {
                    return;
                }

                console.log(`match.bannedMapsCount: ${match.bannedMapsCount}`);
                console.log(`bannedMapsCount: ${bannedMapsCount}`);

                if (match.bannedMapsCount === bannedMapsCount) {
                    this.sendRandomMapBan(banningPlayerId);
                }
            });
    }

    private setEndMatchTimer(firstPlayerId: string, secondPlayerId: string): void {
        timer(MATCH_TIMER + LAG_COMPENSATION)
            .pipe(
                switchMap(() =>
                    from(
                        this.doAxiosPostRequest(`${this.getRoutePrefix()}/api/match/finish`, {
                            firstPlayerId,
                            secondPlayerId,
                            secretKey: config.DUELS_SERVER_PRIVATE_KEY,
                        }),
                    ),
                ),
                take(1),
            )
            .subscribe(() => {
                const firstClient = this.clients$.value.find((client: ClientInterface) => client.playerId === firstPlayerId);
                const secondClient = this.clients$.value.find((client: ClientInterface) => client.playerId === secondPlayerId);

                if (firstClient) {
                    this.send(firstClient.socket, {
                        action: DuelWebsocketServerActions.MATCH_FINISHED,
                    });
                }

                if (secondClient) {
                    this.send(secondClient.socket, {
                        action: DuelWebsocketServerActions.MATCH_FINISHED,
                    });
                }

                console.log(`finishing match between ${firstClient?.playerId} and ${secondClient?.playerId}`);

                this.finishedMatchPlayers$.next([...this.finishedMatchPlayers$.value, firstPlayerId, secondPlayerId]);
                this.matches$.next(
                    this.matches$.value.filter(
                        (match: ServerMatchInterface) => match.firstPlayerId !== firstPlayerId && match.secondPlayerId !== secondPlayerId,
                    ),
                );
            });
    }

    private doAxiosPostRequest(url: string, formData: Record<string, string>): Promise<any> {
        const params = new URLSearchParams();

        Object.entries(formData).forEach(([key, value]: [string, any]) => params.append(key, value));

        return axios.post(url, params);
    }

    private getRoutePrefix(): string {
        return process.env.ENV ? routes[process.env.ENV] : 'http://localhost';
    }
}
